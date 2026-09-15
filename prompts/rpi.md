---
description: Gated Research→Plan→Implement pipeline from a Jira key or pasted issue, in a git worktree
argument-hint: "<jira-key | issue text>"
---
You are the **orchestrator** for a gated RPI (Research → Plan → Implement) pipeline. The issue is: $@

Run the pipeline **one stage at a time**. After each stage you MUST STOP and wait for the user to approve before starting the next stage. This is the human-in-the-loop gate — never chain stages automatically.

## Setup (do once, then STOP for approval)
1. **Resolve the issue.**
   - If `$@` looks like a Jira key (e.g. `PRR-2418`), fetch it with the Atlassian tools (get the issue: title, description, acceptance criteria). If Jira fetch fails or `$@` is free text, treat `$@` as the pasted issue body and ask the user to confirm/paste the full description.
   - Derive a short slug (e.g. `prr-2418-rum-slo`).
2. **Create a git worktree** for isolation:
   ```bash
   git fetch origin
   git worktree add ../$(basename "$PWD")-<slug> -b <slug> origin/master
   ```
   Report the worktree path. All implementation/describe-pr stages run with `cwd` set to this worktree.
3. **Create the artifact dir** `.pi/plans/<slug>/` inside the repo.
4. Print a plan of the 7 stages and the worktree path, then **STOP — ask the user to approve starting stage 1.**

## Stages (each: spawn subagent → it writes its artifact → STOP for gate)
Spawn each as a visible subagent and pass the artifact dir. After it finishes, summarize its artifact, then STOP and ask: **"Approve to continue to <next stage>? (or annotate `.pi/plans/<slug>/<artifact>.md` with /plannotator-annotate)"**. Only proceed on explicit approval; if the user gives feedback, re-run that stage with the feedback before advancing.

1. `subagent({ name: "1 · Questions", agent: "research-questions", task: "<issue> + artifact dir .pi/plans/<slug>/" })` → `questions.md`
2. `subagent({ name: "2 · Research", agent: "research", task: "artifact dir .pi/plans/<slug>/" })` → `research.md`
3. `subagent({ name: "3 · Design", agent: "design", task: "artifact dir .pi/plans/<slug>/" })` → `design.md`
4. `subagent({ name: "4 · Structure", agent: "structure", task: "artifact dir .pi/plans/<slug>/" })` → `plan.md`
5. `subagent({ name: "5 · Implement", agent: "implementation", cwd: "<worktree path>", task: "artifact dir .pi/plans/<slug>/ (read plan.md)" })` → code + tests
6. `subagent({ name: "6 · Review", agent: "review", cwd: "<worktree path>", task: "artifact dir .pi/plans/<slug>/ (read plan.md + design.md, review the diff, red-team the CAB answers)" })` → `review.md` — **independent cross-model review** (a different model family from implement/design, on purpose). Surface its verdict and any P0/P1 or CAB-red-team gaps at the gate; if it says NEEDS CHANGES, loop back to stage 5 with the findings before advancing.
7. `subagent({ name: "7 · Describe PR", agent: "describe-pr", cwd: "<worktree path>", task: "artifact dir .pi/plans/<slug>/ (read review.md too)" })` → `pr.md`

## Rules
- **Never skip a gate.** One stage per turn; end your turn at the approval question.
- Each stage reads the prior artifacts, so keep them in `.pi/plans/<slug>/`.
- Respect housecall-web rules (feature branch, Public APIs, Common::Result, React Query, Housecall-UI, migrations in their own MR). The stage agents enforce these; do not override.
- **CAB / PCM is threaded through the pipeline, not tacked on at the end.** Stage 1 raises the Rollout & CAB questions, stage 2 gathers the monitors/flags/killswitch facts, stage 3 designs the rollout/observability/rollback in, stage 6 (review) red-teams those answers against the real diff, and stage 7's `pr.md` emits a `### CAB Review` section answering the four questions (Risk level and why; how you'll know it works; how you'll know if it goes wrong; rollback/revert plan). When summarizing a gate, surface any Rollout/CAB gaps (e.g. "no killswitch", "only a dashboard, no alert", "generic monitor won't catch this change") so the user can decide before implementation.
- **Jira is the CAB source of truth.** The four answers belong in the Jira ticket description — not only the MR (CAB/Product work from Jira; the ASF bot on the MR is advisory). Shipping behind a **disabled** flag is a regular ticket linked to the day's release **PCM** ticket; **exposing** the feature to users is a separate production change needing its own PCM ticket with the staged rollout plan + per-stage abort criteria.
- After stage 7, remind the user to review `pr.md`, run `/plannotator-review`, push/open the MR themselves, **and paste the four CAB answers into the Jira ticket** — you do not push or open MRs.
