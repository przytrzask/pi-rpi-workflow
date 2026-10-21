---
description: Gated Research→Plan→Implement pipeline from a Jira key or pasted issue, in a git worktree, with HumanLayer RPI skills and a HumanLayer task folder
argument-hint: "<jira-key | issue text>"
---
You are the **orchestrator** for a gated RPI (Research → Plan → Implement) pipeline. The issue is: $@

Run the pipeline **one stage at a time**. After each stage you MUST STOP and wait for the user to approve before starting the next stage. This is the human-in-the-loop gate. Never chain stages automatically.

Stages 1–4 run HumanLayer's RPI skills (research questions → research → design discussion → structure outline). Stages 5–8 are `/rpi`'s own agents (implement → review → browser verify → describe PR). All artifacts live in one **HumanLayer task folder**, so the user can read and comment on them in the HumanLayer web app.

## Setup (do once, then STOP for approval)
1. **Resolve the issue.**
   - If `$@` looks like a Jira key (e.g. `PRR-2418`), fetch it with the Atlassian tools (title, description, acceptance criteria, link). If the Jira fetch fails or `$@` is free text, treat `$@` as the pasted issue body and ask the user to confirm or paste the full description.
   - Derive a short slug (e.g. `prr-2418-rum-slo`). If `$@` names a slug, use that one.
2. **Check the HumanLayer task.** Your system prompt's `artifacts_directory_information` names this session's task folder, `<repo>/.humanlayer/tasks/<task-slug>/`.
   - `ls -La` it. It must be empty, or hold only artifacts for this issue. If it holds another issue's files, this session joined the wrong task: a repo whose `.humanlayer/tasks/` has exactly one link not made by the pi extension joins that task automatically. **STOP** and tell the user to restart with `pi --humanlayer-task new "/rpi $@"`, or with `--humanlayer-task <their task slug>`.
   - No `artifacts_directory_information` (HumanLayer off or signed out): say so and continue in **local mode**. The task folder is then a plain directory and nothing syncs.
3. **Create a git worktree** for isolation:
   ```bash
   git fetch origin
   git worktree add ../$(basename "$PWD")-<slug> -b <slug> origin/master
   ```
4. **Link the task folder into the worktree**, so every stage (all of them run in the worktree) joins the same HumanLayer task and writes to the same folder. The extension joins the task when the cwd's `.humanlayer/tasks/` holds exactly one link it didn't make itself.
   ```bash
   WT=<absolute worktree path>
   mkdir -p "$WT/.humanlayer/tasks"
   ln -s "$(realpath <repo>/.humanlayer/tasks/<task-slug>)" "$WT/.humanlayer/tasks/<task-slug>"   # local mode: mkdir instead of ln -s
   git -C "$WT" check-ignore -q .humanlayer/tasks/x || echo '.humanlayer/' >> "$(git -C "$WT" rev-parse --git-common-dir)/info/exclude"
   ```
   **TASK_DIR** = `$WT/.humanlayer/tasks/<task-slug>` (absolute). Pass it to every stage.
5. **Write `TASK_DIR/ticket.md`**: Jira key and link, title, description, and acceptance criteria, verbatim.
6. Print the 8 stages, the worktree path, TASK_DIR and the HumanLayer session link, then **STOP and ask the user to approve starting stage 1.**

## Stages (each: spawn subagent → it writes its artifact → STOP for gate)
Every stage runs with `cwd: "<worktree path>"`, and its task message starts with `Task dir: <TASK_DIR>. Mode: create.` Stages 1–4 spawn their own research helpers (`codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `web-search-researcher`), so expect extra panes.

**At every gate:**
- `ls -La TASK_DIR`.
- Summarize the new artifact in a few lines and give its path.
- STOP and ask: **"Approve to continue to <next stage>? Or give feedback here, or comment on the artifact in HumanLayer."**
- On feedback, re-run the same stage with `Mode: iterate. Feedback: <the user's words>`. Before re-running, read the artifact's web comments with `get_artifact_comments` (filename only) when that tool is available, and include them. Stages 1–4 then use the matching HumanLayer `iterate-*` skill.
- Only advance on explicit approval.

1. `subagent({ name: "1 · Questions", agent: "research-questions", cwd, task: "Task dir: <TASK_DIR>. Mode: create. Ticket: <TASK_DIR>/ticket.md" })` → `NN-research-questions-*.md`
2. `subagent({ name: "2 · Research", agent: "research", cwd, task: "Task dir: <TASK_DIR>. Mode: create." })` → `NN-research-*.md` (it deliberately never reads the ticket)
3. `subagent({ name: "3 · Design", agent: "design", cwd, task: "Task dir: <TASK_DIR>. Mode: create." })` → `NN-design-discussion-*.md`. Its design questions start **open**: at the gate, list them with the recommendation for each and ask the user to decide. Re-run in iterate mode with the decisions until none are open. **Do not offer stage 4 while a design question is open.** Also surface any gap in its *Rollout, Observability & Rollback* section.
4. `subagent({ name: "4 · Structure", agent: "structure", cwd, task: "Task dir: <TASK_DIR>. Mode: create." })` → `NN-structure-outline-*.md`: phases as vertical slices, each with its own validation, ending with an **Acceptance criteria** list. If it reports open design questions instead, go back to stage 3.
5. `subagent({ name: "5 · Implement", agent: "implementation", cwd, task: "Task dir: <TASK_DIR>. Mode: create. Implement the structure outline phase by phase." })` → code, one commit per phase, and `✅` marks in the outline. At the gate, list the manual verification steps it left for the user.
6. `subagent({ name: "6 · Review", agent: "review", cwd, task: "Task dir: <TASK_DIR>. Review the diff against the structure outline and red-team the design discussion's CAB answers." })` → `NN-review.md`. This is an **independent review** (Sonnet reviewing what Opus designed and built, on purpose). Surface its verdict and any P0/P1 or CAB red-team gaps at the gate. If it says NEEDS CHANGES, loop back to stage 5 with the findings before advancing.
7. **Verify in the browser** (`/verify-change` skill). The skill checks what is *served* and never serves it. The default target is **staging**; `local` is the fallback. Ephemeral environments are still a proof of concept, so don't offer them yet. At the stage-6 gate, ask the user to confirm the target and the **flag state** the change needs on that environment (they set flags themselves; the skill only records them). Then get the change served:
   - **Staging (default).** Staging deploys the shared `staging` branch: scheduled, batched pipelines about every 20 minutes. The user merges the feature branch into it with `./scripts/push_to_staging.sh` from the worktree. **You never run it.** It changes a shared environment, so it's the user's call. Before asking, check `git -C <worktree> rev-parse --is-shallow-repository`. If it prints `true`, warn that the script fails from a shallow clone (GitLab's 10-minute fetch limit). The fix is `git fetch --unshallow origin` once, which is slow, or pushing from a full clone. Also warn that the script type-checks for about 25 minutes on a cold cache, and that staging is reset to master from time to time. When the user says it's pushed, run `~/.pi/agent/skills/verify-change/scripts/wait-for-staging-deploy.sh $(git -C <worktree> rev-parse HEAD) --timeout-min 60` (it polls until a successful staging deploy contains the commit). Twingate must be on.
   - **Local (fallback).** The user runs `bin/dev` from the worktree, not the main checkout.

   Then run `~/.pi/agent/skills/verify-change/scripts/preflight.sh --target <target> --checkout <worktree path>`. If it fails, show its fix and wait.

   `subagent({ name: "7 · Verify", agent: "verify", cwd, task: "Task dir: <TASK_DIR>. Jira <key or none>; --target <target>; --flags <flags or none>" })` → evidence under `<worktree>/tmp/verify/…`, plus `NN-verify-<target>.md` and `NN-verify-<target>.result.json` in TASK_DIR. The agent asks for checklist approval **in its own pane**, so tell the user to answer there.

   At the gate, read the `.result.json` (`final` must be true) and branch on `overall`:
   - **PASS**: offer stage 8.
   - **FAIL**: loop back to stage 5 with the failures, then re-run 6 and 7 (the tests and the org are reused).
   - **INCOMPLETE**: surface the BLOCKED items and their fixes, and let the user decide whether to fix and rerun or accept.

   Also surface `findings[]`, and ask which `proposedCriterion` entries should become new acceptance criteria.
8. `subagent({ name: "8 · Describe PR", agent: "describe-pr", cwd, task: "Task dir: <TASK_DIR>." })` → `NN-pr-description.md`

## Rules
- **Never skip a gate.** One stage per turn; end your turn at the approval question.
- **One folder.** Every artifact goes in TASK_DIR and is never committed. `.humanlayer/` is git-excluded; check it before any commit. Later documents win where they disagree: structure outline > design discussion > research > ticket.
- Respect housecall-web rules (feature branch, Public APIs, Common::Result, React Query, Housecall-UI, migrations in their own MR). The stage agents enforce these; do not override.
- **CAB / PCM runs through the whole pipeline, not just the end:**
  - Stage 1 asks what monitors, flags and killswitches exist.
  - Stage 2 documents them.
  - Stage 3 designs rollout, observability and rollback in, and lists open decisions.
  - Stage 6 (review) red-teams those answers against the real diff.
  - Stage 7 (verify) gives evidence for "how you'll know it works".
  - Stage 8 emits a `### CAB Review` section answering the four questions: risk level and why; how you'll know it works; how you'll know if it goes wrong; rollback/revert plan.

  When summarizing a gate, surface any Rollout/CAB gaps (e.g. "no killswitch", "only a dashboard, no alert", "generic monitor won't catch this change") so the user can decide before implementation.
- **Jira is the CAB source of truth.** The four answers belong in the Jira ticket description, not only the MR: CAB and Product work from Jira, and the ASF bot on the MR is advisory. Shipping behind a **disabled** flag is a regular ticket linked to the day's release **PCM** ticket. **Exposing** the feature to users is a separate production change that needs its own PCM ticket with the staged rollout plan and per-stage abort criteria.
- After stage 8, remind the user to:
  - review `NN-pr-description.md`
  - run `/plannotator-review`
  - push and open the MR themselves
  - **paste the four CAB answers into the Jira ticket**

  You do not push or open MRs.
