# pi-rpi-workflow

A gated **Research → Plan → Implement** pipeline for the [pi coding agent](https://github.com/earendil-works/pi), built on [HumanLayer](https://humanlayer.com)'s RPI skills.

Turns an issue (Jira key or pasted text) into a reviewed MR through eight stages, each running as a visible [Herdr](https://herdr.dev) subagent that writes an artifact and **stops for human approval** before the next stage. Stages 1–4 run HumanLayer's own RPI skills (research questions, research, design discussion, structure outline), and every artifact goes into one **HumanLayer task folder**, so you can read and comment on it in the HumanLayer web app. See [HumanLayer integration](#humanlayer-integration). Stage 6 is an **independent review** (Sonnet 5.5 reviewing what Opus 5.5 designed and built) that red-teams the CAB answers, and stage 7 **verifies the served change in a real browser** with the [`/verify-change`](#stage-7--browser-verification) skill, leaving PASS / FAIL / INCOMPLETE evidence.

Each `→` is a human approval gate. Implementation runs in an isolated git worktree on a feature branch.

Production-change review (**PL-CAB / PCM**) is threaded through the pipeline rather than bolted on at the end: the four CAB questions (risk, works-in-prod, goes-wrong, rollback) are raised in stage 1, grounded with real monitors / feature-flags / killswitch facts in stage 2, designed in (incl. staged-rollout abort criteria) in stage 3, red-teamed against the real diff by the review in stage 6, backed by browser evidence in stage 7, and emitted as a ready-to-paste **`### CAB Review`** block in stage 8's PR description. See [PL-CAB / PCM built in](#pl-cab--pcm-built-in).

```mermaid
flowchart TB
    T["/rpi &lt;issue&gt;"] --> O["Orchestrator (main pi session)"]
    O -->|"resolve Jira / manual input"| SETUP["git worktree + HumanLayer task folder<br/>(linked into the worktree)"]
    O -->|"spawn each stage · gate between"| S1

    subgraph Pipeline["Gated RPI pipeline — each stage = Herdr subagent + artifact + approval"]
        direction TB
        S1["1 · research-questions (HL skill)<br/>sonnet-5.5 · low → NN-research-questions"]:::changed
        S2["2 · research (HL skill)<br/>sonnet-5.5 · medium → NN-research"]:::changed
        S3["3 · design discussion (HL skill)<br/>opus-5.5 · high → NN-design-discussion"]:::changed
        S4["4 · structure outline (HL skill)<br/>opus-5.5 · high → NN-structure-outline"]:::changed
        S5["5 · implementation<br/>opus-5.5 · medium → a commit per phase"]
        S6["6 · review<br/>sonnet-5.5 · high → NN-review"]
        S7["7 · verify (/verify-change)<br/>sonnet-5.5 · medium → NN-verify"]
        S8["8 · describe-pr<br/>opus-5.5 · medium → NN-pr-description"]
        S1 -->|"approve"| S2 -->|"approve"| S3 -->|"all design questions resolved"| S4 -->|"approve"| S5 -->|"approve"| S6 -->|"approve"| S7 -->|"PASS · approve"| S8
        S7 -->|"FAIL"| S5
    end

    S5 -->|"cwd = worktree"| WT["housecall-web-&lt;slug&gt; · feature branch"]
    S8 --> MR["open MR (human pushes)"]

    classDef changed stroke:#bf8700,stroke-width:2px
```

## PL-CAB / PCM built in

The pipeline produces the answers a production-change review expects, from facts gathered along the way instead of guesses written at the finish line. Every change's Jira ticket must answer four questions, so each stage does part of the work:

| Stage | CAB/PCM contribution |
|---|---|
| 1 · research-questions | Asks what monitors, alerts, flags/killswitches and stored state exist today for the code being changed |
| 2 · research | Documents them with citations in a **Rollout & observability facts** section; never invents a link |
| 3 · design discussion | Designs rollout / observability / rollback **in** (killswitch, which alert catches a regression, staged-rollout abort criteria); anything undecided becomes an open design question |
| 6 · review | **Red-teams** the four answers against the real diff (honest risk, real signal, named alert, safe rollback) |
| 7 · verify | Browser evidence (screenshots, video, trace) that the served change meets the acceptance criteria — backs answer 2 |
| 8 · describe-pr | Emits `### Rollout` + `### CAB Review` blocks answering all four, with a quality bar for the common rejections |

**The four questions** (put these in the **Jira ticket description** — the source of truth for CAB; the MR copy and ASF bot are advisory):

1. **Risk level and why?** (Low / Medium / High)
2. **How will you know it works correctly in production?**
3. **How will you know if something goes wrong?**
4. **What's your rollback / revert plan?**

"N/A" is a valid answer when genuinely true (e.g. spec-only change) — just say so explicitly. The bar: *a reviewer who doesn't know your domain can understand the risk.*

> The CAB wording embeds HCP's [PL CAB approval process](https://housecall.atlassian.net/wiki/spaces/ENG/pages/4432592978/) and [CAB Review — Frequent Feedback](https://housecall.atlassian.net/wiki/spaces/ENG/pages/4468637769/). Adapt or drop it if your org has a different change-management process.

## Requirements

- pi coding agent
- [`pi-herdr-subagents`](https://www.npmjs.com/package/pi-herdr-subagents) — spawns each stage as a Herdr tab
- Running inside Herdr (for visible stage panes)
- [`humanlayer-pi`](https://github.com/humanlayer/humanlayer-pi) (`pi install git:github.com/humanlayer/humanlayer-pi`, then `/humanlayer login`): provides the stage 1–4 skills and the task folder sync. Without a login, `/rpi` runs in local mode: same skills, plain folder, nothing syncs
- [`verify-change`](https://gitlab.housecalldev.com/adrian.wawryczuk/payrollaiharness) for stage 7
- Optional: `@plannotator/pi-extension` for `/plannotator-review`; Atlassian MCP for Jira issue resolution and CAB-doc lookups

## Install

```bash
git clone <this-repo> pi-rpi-workflow
cd pi-rpi-workflow
./install.sh          # symlinks agents + prompt into ~/.pi/agent, copies example config
```

Then restart pi inside a Herdr pane. Run:

```
/rpi PRR-1234          # from a Jira key
/rpi <paste issue text>
```

In a repo whose `.humanlayer/tasks/` already links another task, start with `pi --humanlayer-task new "/rpi PRR-1234"`; otherwise the session joins that task (see below).

## What it installs

| Path | What |
|---|---|
| `~/.pi/agent/agents/{research-questions,research,design,structure,implementation,review,verify,describe-pr}.md` | The eight stage agents (model/effort tuned per stage) |
| `~/.pi/agent/agents/{codebase-locator,codebase-analyzer,codebase-pattern-finder,web-search-researcher}.md` | Research helpers the HumanLayer skills call, adapted from [humanlayer/humanlayer](https://github.com/humanlayer/humanlayer/tree/main/.claude/agents) (Apache-2.0) |
| `~/.pi/agent/prompts/rpi.md` | The `/rpi` orchestrator command |
| `~/.pi/agent/skills/verify-change` | Symlink to `~/.claude/skills/verify-change` (if installed), so stage 7 can load it |
| `~/.pi/agent/extensions/subagent/config.json` | Per-agent model routing (from the example, if you don't already have one) |

## Model routing (edit to taste)

| Stage | Model | Thinking |
|---|---|---|
| research-questions | sonnet-5-5 | low |
| research | sonnet-5-5 | medium |
| design | opus-5-5 | high |
| structure | opus-5-5 | high |
| implementation | opus-5-5 | medium |
| review | sonnet-5-5 | high |
| verify | sonnet-5-5 | medium |
| describe-pr | opus-5-5 | medium |
| research helpers (4) | sonnet-5-5 | low (locator) / medium |

Only Sonnet 5.5 and Opus 5.5 are used. Neither offers `minimal` thinking, so stage 1 runs at `low`.

Change per-agent via the `model:`/`thinking:` frontmatter in each `agents/*.md`, or globally in `config/subagent-config.example.json`.

## Stage 7 — browser verification

Stage 7 runs the [`verify-change`](https://gitlab.housecalldev.com/adrian.wawryczuk/payrollaiharness) skill (install it first, see its `setup.md`). It checks what is **served** and never serves it, so at the stage-6 gate the orchestrator asks for:

- the **target**: `local` (default) or `staging`
- the **flag state** the change needs
- the worktree **served**: `bin/dev` running from the worktree for local, or pushed and deployed for staging (you push, the pipeline never does)

It runs `preflight.sh`, then spawns the `verify` agent, which asks for checklist approval in its own pane. The evidence (screenshots, video, traces) stays in the worktree's git-ignored `tmp/verify/`, so it doesn't sync to HumanLayer. `verify.md` and `result.json` are copied into the task folder as `NN-verify-<target>.md` and `NN-verify-<target>.result.json`. The gate reads the result:

- **PASS**: go on to describe-pr
- **FAIL**: back to stage 5, then rerun stages 6 and 7
- **INCOMPLETE**: the blocked items are listed and you decide

The `verify.md` summary table goes into the MR's Testing section.

## HumanLayer integration

**Skills.** Stages 1–4 read HumanLayer's skills straight from the humanlayer-pi package (`~/.pi/agent/git/github.com/humanlayer/humanlayer-pi/skills/`): `create-*` on the first run, `iterate-*` when you give feedback at a gate. They don't use the agent `skills:` field, because pi-herdr-subagents sends each listed skill as its own prompt *before* the task, so the model would run it without knowing its mode. The same goes for `verify-change` in stage 7.

**Tools.** An agent's `tools:` line is a full allowlist (pi's `--tools` covers extension tools too). So stages 1–4 list `subagent` for the research helpers, and the research and web agents list the web, MCP (`codemode`) and HumanLayer comment tools they use. The agents follow those skills as written and add only what `/rpi` needs on top: the Rollout & CAB questions and facts, the `## Rollout, Observability & Rollback` design section, the housecall-web rules, and an **Acceptance criteria** list at the end of the outline for stage 7. The skills hand codebase and web research to the four helper agents, so stages 1–4 open extra panes.

HumanLayer's design discussion keeps every design question **open** until you decide it. The gate after stage 3 lists them and re-runs the stage with your decisions until none are left; stage 4 refuses to start while any is open.

**Stages 5–8 stay `/rpi`'s own.** HumanLayer's `implement-outline` needs an implementer agent it doesn't publish, and its `describe-pr` is GitHub-only and pushes the branch. So the implementation agent works the outline phase by phase (verify, mark `✅`, commit), and describe-pr writes a GitLab MR description with the CAB Review.

**The task folder.** The orchestrator uses its own HumanLayer task folder, writes `ticket.md` there, and symlinks that folder into the new worktree as `.humanlayer/tasks/<task-slug>`. Every stage runs in the worktree. The humanlayer-pi extension joins a task when the cwd's `.humanlayer/tasks/` holds exactly one link it didn't make itself, so each stage's session joins the **same** task. Everything lands in one folder and shows under one task in the web app. You can comment on an artifact there; the orchestrator reads the comments with `get_artifact_comments` when you ask for changes.

Files are named `NN-<kind>-<description>.md`, numbered in order, and the newest of each kind wins. `.humanlayer/` is git-excluded, so nothing in it gets committed.

**Known limits.**
- The HumanLayer board stays at Todo/Draft. It's read-only and follows HumanLayer's own workflow phases, which a pi-created task doesn't have.
- The same "one foreign link" rule is why a repo like `housecall-web`, whose `.humanlayer/tasks/` holds one task made by the HumanLayer app, sends every new pi session into that task. Start `/rpi` with `--humanlayer-task new`; setup stops if it finds another issue's files.

## Notes

- The stage agents embed repo guardrails as an example (feature branch, Public APIs, migrations in their own MR). Adapt the `## Constraints` sections in each agent to your codebase's rules (or your `AGENTS.md`).
- Gates are enforced by the orchestrator: one stage per turn, and it stops for your `go`. Nothing chains automatically.
- **The review uses a different model on purpose.** Opus designs and writes (stages 3–5), Sonnet reviews (stage 6), so the reviewer doesn't share the author's reasoning. Sonnet and Opus are the same model family, so this is less independent than a cross-family review; to get that back, set `agents/review.md` to a model from another family.

## License

MIT
