// @options: {"timeout_ms": 180000, "max_output_tokens": 12000}
// Golden Signals Gardener — live scoreboard + pick for epic PRR-2409.
// Run VERBATIM as a codemode script body. Returns JSON { window, scoreboard, pick, skipped, notInEpic }.
// Formula (epic PRR-2409): breach = actual / threshold per failing dimension;
// severity = min(max breach, 10) * (1 + 0.1 * (failingDims - 1)); score = severity * sqrt(sessions).

const EPIC = "PRR-2409";
const CLOUD = "housecall.atlassian.net";
const FROM = "now-30d";
const APP = "@application.name:housecall-web-pros @session.type:user env:production";
const TEAMS = "team:(payroll OR payroll-acquisition-and-activation OR payroll-revenue-and-retention)";
const MIN_SESSIONS = 10;
const T = { lt: 2.5e9, inp: 200e6, cls: 0.1, api: 0.01, err: 0.01 }; // ns, ns, score, ratio, ratio
// Clusters from the epic: a story is skipped if a cluster-mate is In Progress (shared root cause).
const CLUSTERS = {
  time_tracking: ["/app/time_tracking", "/app/time_tracking/?", "/app/time_tracking/timesheet/?"],
  payroll_main: ["/app/payroll", "/app/payroll/overview", "/app/payroll/get_started"],
  token: ["/app/payroll/update-data/token/?", "/app/payroll/tax-documents/token/?", "/app/payroll/onboard/token/?"],
  onboarding: ["/app/payroll/onboarding", "/app/payroll/self_onboarding", "/app/payroll/onboard/mobile", "/app/payroll/onboarding_get_started"],
  documents: ["/app/payroll/documents", "/app/payroll/documents/history", "/app/payroll/documents/reports"],
  employees: ["/app/payroll/employees", "/app/payroll/employees/?/pay", "/app/payroll/employees/?/details", "/app/payroll/employees/?/taxes"],
};
const clusterOf = (v) => Object.keys(CLUSTERS).find((k) => CLUSTERS[k].includes(v));
const tel = { intent: "Golden-signals gardener: live per-view SLO scoreboard for Payroll RUM SLO epic, to pick the next story to fix" };

// 1. Epic stories → views in scope ("[RUM SLO] Improve <view>")
const jr = await tools.mcp__atlassian__searchJiraIssuesUsingJql({
  cloudId: CLOUD, jql: `parent = ${EPIC} ORDER BY Rank ASC`,
  fields: ["summary", "status", "assignee"], maxResults: 100,
});
const issues = JSON.parse(jr.content[0].text).data.issues;
const stories = issues
  .map((i) => {
    const m = i.fields.summary.match(/\[RUM SLO\]\s*Improve\s+(\S+)/i);
    return m && { key: i.key, view: m[1], status: i.fields.status.name, assignee: i.fields.assignee?.displayName || null };
  })
  .filter(Boolean);
const inScope = [...new Set(stories.map((s) => s.view))];

// 2. Datadog: 5 dimensions per view, filtered to our views
const viewFilter = `@view.url_path_group:(${inScope.map((v) => `"${v}"`).join(" OR ")})`;
const tsv = (r) => {
  const body = r.content[0].text.split("<TSV_DATA>")[1];
  if (!body) return [];
  const rows = body.split("</TSV_DATA>")[0].trim().split("\n");
  const h = rows[0].split("\t");
  return rows.slice(1).map((l) => { const c = l.split("\t"); const o = {}; h.forEach((k, i) => (o[k] = c[i])); return o; });
};
const agg = (query, computes, fields = ["@view.url_path_group"]) =>
  tools.mcp__datadog__aggregate_rum_events({ query, from: FROM, to: "now", computes, group_by: { fields, limit: 1000 }, telemetry: tel }).then(tsv);
const RES = `@type:resource ${APP} ${viewFilter} @resource.type:(fetch OR xhr) @resource.url_host:pro.housecallpro*`;
const [views, viewsWithErr, resAll, resFail, newOffenders] = await Promise.all([
  agg(`@type:view ${APP} ${viewFilter}`, [
    { aggregation: "CARDINALITY", field: "@session.id", output: "sessions", sort: "desc" },
    { aggregation: "P95", field: "@view.loading_time", output: "lt" },
    { aggregation: "P95", field: "@view.interaction_to_next_paint", output: "inp" },
    { aggregation: "P95", field: "@view.cumulative_layout_shift", output: "cls" },
    { aggregation: "COUNT", field: "*", output: "n" },
  ]),
  agg(`@type:view ${APP} ${viewFilter} @view.error.count:>0`, [{ aggregation: "COUNT", field: "*", output: "n", sort: "desc" }]),
  agg(RES, [{ aggregation: "COUNT", field: "*", output: "n", sort: "desc" }]),
  agg(`${RES} @resource.status_code:>=400 -@resource.status_code:401`, [{ aggregation: "COUNT", field: "*", output: "n", sort: "desc" }]),
  // our-team views NOT in the epic (report only; the gardener never works on them)
  agg(`@type:view ${APP} ${TEAMS} -${viewFilter}`, [
    { aggregation: "CARDINALITY", field: "@session.id", output: "sessions", sort: "desc" },
    { aggregation: "P95", field: "@view.loading_time", output: "lt" },
  ]),
]);
const by = (rows) => Object.fromEntries(rows.map((r) => [r["@view.url_path_group"], r]));
const E = by(viewsWithErr), RA = by(resAll), RF = by(resFail);
const num = (x) => (x === undefined || x === "" ? null : Number(x));

const scoreboard = views.map((r) => {
  const v = r["@view.url_path_group"];
  const sessions = num(r.sessions), n = num(r.n) || 0;
  const m = {
    lt: num(r.lt), inp: num(r.inp), cls: num(r.cls),
    api: RA[v] ? (num(RF[v]?.n) || 0) / num(RA[v].n) : null,
    err: n ? (num(E[v]?.n) || 0) / n : null, // share of views with >=1 FE error (error-free = 1 - err)
  };
  const ratios = Object.fromEntries(Object.keys(T).map((k) => [k, m[k] == null ? 0 : m[k] / T[k]]));
  const failing = Object.keys(T).filter((k) => ratios[k] > 1);
  const severity = failing.length ? Math.min(Math.max(...failing.map((k) => ratios[k])), 10) * (1 + 0.1 * (failing.length - 1)) : 0;
  const story = stories.find((s) => s.view === v);
  return {
    view: v, story: story?.key, status: story?.status, assignee: story?.assignee, sessions,
    lt_s: m.lt && +(m.lt / 1e9).toFixed(2), inp_ms: m.inp && Math.round(m.inp / 1e6), cls: m.cls && +m.cls.toFixed(3),
    api_fail_pct: m.api == null ? null : +(m.api * 100).toFixed(2), error_free_pct: m.err == null ? null : +((1 - m.err) * 100).toFixed(2),
    failing, score: +(severity * Math.sqrt(sessions || 0)).toFixed(1),
  };
}).sort((a, b) => b.score - a.score);

// 3. Pick: highest score that is workable
const inProgressClusters = new Set(stories.filter((s) => /progress|review/i.test(s.status)).map((s) => clusterOf(s.view)).filter(Boolean));
const skipped = [];
const candidates = [];
for (const row of scoreboard) {
  const reason =
    !row.failing.length ? "passing" :
    row.sessions < MIN_SESSIONS ? `low volume (${row.sessions} sessions)` :
    /done|closed/i.test(row.status || "") ? "story Done (use /gardener verify)" :
    /progress|review/i.test(row.status || "") ? `story ${row.status}` :
    row.assignee ? `assigned to ${row.assignee}` :
    inProgressClusters.has(clusterOf(row.view)) ? `cluster '${clusterOf(row.view)}' has work in progress` : null;
  if (reason) { skipped.push({ view: row.view, story: row.story, score: row.score, reason }); continue; }
  candidates.push(row);
}
const pick = candidates[0] || null; // orchestrator takes the first candidate without an open gardener MR/branch
const missing = inScope.filter((v) => !views.find((r) => r["@view.url_path_group"] === v));
return {
  window: `${FROM}..now`, thresholds: "LT<=2.5s INP<=200ms CLS<=0.1 API fail<=1% error-free>=99%",
  pick, candidates: candidates.map((c) => ({ story: c.story, view: c.view, score: c.score, failing: c.failing })),
  skipped, scoreboard, noTrafficInWindow: missing,
  notInEpic: newOffenders.filter((r) => num(r.sessions) >= MIN_SESSIONS).slice(0, 15)
    .map((r) => ({ view: r["@view.url_path_group"], sessions: num(r.sessions), lt_s: r.lt && +(num(r.lt) / 1e9).toFixed(2) })),
};
