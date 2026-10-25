/**
 * Lab A/B test helpers. lab.sh copies this file into <dir>/project/. Import `test` from here, not
 * from '@e2e-dev/web': it adds verify-change's network allowlist to every attempt, so a lab run
 * never reaches production or third parties.
 *
 *   import { test, startVitals, vitals } from '../lab.ts';
 *
 *   await startVitals(browser)      before app.open: observe layout shifts, LCP, interactions, page errors
 *   await vitals(browser, 'AB2')    read them; one run line in <dir>/<side>/vitals/AB2-page.runs.jsonl
 *   await recordFlag(browser, key)  the variant the page got for `key`, kept in <dir>/<side>/flags.jsonl
 *
 * Visual checks use e2e's own matcher: `await expect(screen).toHaveScreenshot('AB1-settled', { mask })`.
 * The before run writes the stored screenshot (--update-snapshots), the after run compares with it.
 *
 * lab.sh sets LAB_DIR, LAB_SIDE (before | after | check) and LAB_RUN_ID for every e2e run.
 */
import { test as base } from '@e2e-dev/web';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowed, policyFor } from './network-policy.mjs';

const lab = JSON.parse(readFileSync(new URL('./lab.json', import.meta.url), 'utf8'));
const policy = policyFor({ target: lab.target, targets: { [lab.target]: { allowHosts: lab.allowHosts } }, network: lab.network });
const LAB_DIR = process.env.LAB_DIR ?? '';
const SIDE = process.env.LAB_SIDE ?? 'adhoc';
const RUN_ID = process.env.LAB_RUN_ID ?? 'adhoc';

type Guarded = {
  route(p: RegExp, h: (r: { request: { url: string }; abort(): Promise<void>; fallback(): Promise<void> }) => Promise<void>): Promise<void>;
};

/** `test` with the network allowlist on every attempt. `block` aborts hosts outside `allowHosts`. */
export const test = base.extend<{ networkGuard: { blocked: string[] } }>({
  networkGuard: async ({ browser }: { browser: Guarded }, use: (g: { blocked: string[] }) => Promise<void>) => {
    const guard = { blocked: [] as string[] };
    if (policy.mode === 'block') {
      await browser.route(/.*/, async (route) => {
        if (allowed(route.request.url, policy.allowHosts)) return route.fallback();
        guard.blocked.push(route.request.url);
        return route.abort();
      });
    }
    await use(guard);
  },
});

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Records the Amplitude variant the page got for `key`, from the client's cache
 * (localStorage `amp-exp-$default_instance-*`, e.g. `{ key: "using-<key>" }`), in
 * <dir>/<side>/flags.jsonl. compare.mjs refuses a run whose after side never saw `using-<key>` or
 * whose before side did. A backend-only flag the client never fetches records `null`: unproven.
 * Call it once the page has loaded.
 */
export async function recordFlag(browser: { evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T> }, key: string): Promise<string | null> {
  const variant = await browser.evaluate((k: string) => {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i) ?? '';
      if (!name.startsWith('amp-exp-')) continue;
      try {
        const v = (JSON.parse(localStorage.getItem(name) ?? '{}') as Record<string, { key?: string; value?: string }>)[k];
        if (v) return v.key ?? v.value ?? null;
      } catch {
        /* not a variant cache */
      }
    }
    return null;
  }, key);
  if (LAB_DIR) {
    mkdirSync(join(LAB_DIR, SIDE), { recursive: true });
    appendFileSync(join(LAB_DIR, SIDE, 'flags.jsonl'), `${JSON.stringify({ runId: RUN_ID, side: SIDE, key, variant, at: new Date().toISOString() })}\n`);
  }
  return variant;
}

type InitScripts = { addInitScript(fn: () => unknown): Promise<void> };
type Evaluator = { evaluate<T>(fn: () => T | Promise<T>): Promise<T> };

/**
 * Installs the observers `vitals()` reads, in every document from the next navigation: layout
 * shifts (with the selectors of the elements that moved), the largest contentful paint, interaction
 * event timings, uncaught errors and unhandled rejections. Call it before `app.open`.
 */
export async function startVitals(browser: InitScripts): Promise<void> {
  await browser.addInitScript(() => {
    const w = window as unknown as { __labVitals?: unknown };
    if (w.__labVitals) return;
    const v = { errors: [] as string[], shifts: [] as unknown[], lcp: null as number | null, events: [] as unknown[] };
    w.__labVitals = v;
    const sel = (n: Node | null | undefined): string | null => {
      const parts: string[] = [];
      let el = n && n.nodeType === 1 ? (n as Element) : null;
      for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) {
        const cls = [...el.classList].filter((c) => !/^css-/.test(c)).slice(0, 2).map((c) => `.${c}`).join('');
        parts.unshift(el.id ? `${el.tagName}#${el.id}` : `${el.tagName}${cls}`);
        if (el.id) break;
      }
      return parts.length ? parts.join(' > ') : null;
    };
    addEventListener('error', (e) => v.errors.push(String((e as ErrorEvent).message || 'error').slice(0, 300)));
    addEventListener('unhandledrejection', (e) => {
      const r = (e as PromiseRejectionEvent).reason as { message?: string } | undefined;
      v.errors.push(`unhandled rejection: ${String(r?.message ?? r)}`.slice(0, 300));
    });
    const observe = (type: string, cb: (entries: PerformanceEntry[]) => void, extra: Record<string, unknown> = {}) => {
      try {
        new PerformanceObserver((list) => cb(list.getEntries())).observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      } catch {
        /* not supported by this engine: the metric stays empty */
      }
    };
    observe('layout-shift', (es) => {
      for (const e of es as unknown as { value: number; startTime: number; hadRecentInput: boolean; sources?: { node?: Node }[] }[]) {
        v.shifts.push({ value: e.value, t: e.startTime, input: e.hadRecentInput, sources: (e.sources ?? []).map((s) => sel(s.node)).filter(Boolean) });
      }
    });
    observe('largest-contentful-paint', (es) => {
      const last = es.at(-1);
      if (last) v.lcp = last.startTime;
    });
    observe('event', (es) => {
      for (const e of es as unknown as { duration: number; name: string; interactionId?: number }[]) {
        if (e.interactionId) v.events.push({ d: e.duration, name: e.name, id: e.interactionId });
      }
    }, { durationThreshold: 16 });
  });
}

type Shift = { value: number; t: number; input: boolean; sources: string[] };
const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/** CLS the way web-vitals and RUM count it: the largest session window of shifts without recent input. */
export function clsOf(shifts: Shift[]): { cls: number; topSelectors: { selector: string; value: number }[] } {
  let best = 0, sum = 0, first = -Infinity, prev = -Infinity;
  const bySelector = new Map<string, number>();
  for (const s of shifts.filter((x) => !x.input).sort((a, b) => a.t - b.t)) {
    if (s.t - prev > 1000 || s.t - first > 5000) { sum = 0; first = s.t; }
    sum += s.value;
    prev = s.t;
    best = Math.max(best, sum);
    for (const sel of s.sources) bySelector.set(sel, (bySelector.get(sel) ?? 0) + s.value);
  }
  const topSelectors = [...bySelector].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([selector, value]) => ({ selector, value: round(value, 4) }));
  return { cls: round(best, 4), topSelectors };
}

/**
 * Reads what `startVitals` observed, plus navigation and resource timings, and appends one run
 * line to <dir>/<side>/vitals/<ID>-<label>.runs.jsonl. Metrics:
 *   cls             largest session window (deterministic for the same build, org and viewport)
 *   failedRequests  fetch/XHR answered 4xx/5xx other than 401 (the API failure SLO's rule)
 *   errors          uncaught errors and unhandled rejections
 *   lcp, inp, ttfb  milliseconds; inp is the longest interaction of this test (indicative)
 *   loadToIdle      the last fetch/XHR response or the load event, whichever is later: an
 *                   approximation of RUM's loading time (indicative)
 */
export async function vitals(browser: Evaluator, id: string, label = 'page'): Promise<Record<string, unknown>> {
  const raw = await browser.evaluate(() => {
    const v = (window as unknown as { __labVitals?: { errors: string[]; shifts: unknown[]; lcp: number | null; events: { d: number; id: number }[] } }).__labVitals;
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const api = (performance.getEntriesByType('resource') as (PerformanceResourceTiming & { responseStatus?: number })[])
      .filter((r) => r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest')
      .map((r) => ({ path: new URL(r.name).pathname, status: r.responseStatus ?? null, end: r.responseEnd }));
    return {
      observed: Boolean(v),
      shifts: v?.shifts ?? [],
      lcp: v?.lcp ?? null,
      events: v?.events ?? [],
      errors: v?.errors ?? [],
      ttfb: nav ? nav.responseStart : null,
      loadEnd: nav ? nav.loadEventEnd : null,
      api,
    };
  });
  if (!raw.observed) throw new Error(`vitals(${id}): call startVitals(browser) before app.open, so the page is observed from its first paint`);
  const { cls, topSelectors } = clsOf(raw.shifts as Shift[]);
  const failed = raw.api.filter((r) => r.status !== null && r.status >= 400 && r.status !== 401);
  const perInteraction = new Map<number, number>();
  for (const e of raw.events) perInteraction.set(e.id, Math.max(perInteraction.get(e.id) ?? 0, e.d));
  const metrics = {
    cls,
    failedRequests: failed.length,
    errors: raw.errors.length,
    lcp: raw.lcp === null ? null : Math.round(raw.lcp),
    inp: perInteraction.size ? Math.max(...perInteraction.values()) : null,
    ttfb: raw.ttfb === null ? null : Math.round(raw.ttfb),
    loadToIdle: Math.round(Math.max(raw.loadEnd ?? 0, ...raw.api.map((r) => r.end))),
  };
  const details = {
    clsSelectors: topSelectors,
    failed: failed.map((r) => `${r.status} ${r.path}`),
    errors: raw.errors.slice(0, 20),
    apiRequests: raw.api.length,
    interactions: perInteraction.size,
  };
  if (LAB_DIR) {
    const dir = join(LAB_DIR, SIDE, 'vitals');
    mkdirSync(dir, { recursive: true });
    const line = { runId: RUN_ID, side: SIDE, id, label, at: new Date().toISOString(), metrics, details };
    appendFileSync(join(dir, `${id}-${label}.runs.jsonl`), `${JSON.stringify(line)}\n`);
  }
  return { ...metrics, details };
}
