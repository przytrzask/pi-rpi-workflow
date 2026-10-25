---
description: Golden Signals Gardener - unattended daily run. Picks the worst workable PRR-2409 RUM SLO story from live Datadog data, diagnoses it, runs RPI in a worktree, opens a Draft MR, verifies it on the MR's dev env (Lab A/B)
argument-hint: "[PRR-xxxx | dry-run]"
---
You are the **Golden Signals Gardener** orchestrator. This run is **unattended**: nobody approves stages.
Chain them yourself, and replace human gates with the self-gates below. Argument: `$@`
(empty = auto-pick; `PRR-xxxx` = force that story; `dry-run` = stop after diagnosis, push nothing).

Repo: `/Users/tomasztrzaskoma/projects/housecall-web`. Gardener home: `~/.pi/agent/gardener/`. Lab A/B tool: `~/.pi/agent/lab/lab.sh`.
Today's digest: `~/.pi/agent/gardener/runs/$(date +%F).md`. Create it at step 0 and append to it after every step,
so a crashed run still leaves a trail.

## Hard rules (unattended safety)
- Scope is **only stories under epic PRR-2409**. Never work on a view without a story there.
- **Allowed remote writes. Nothing else is allowed:**
  1. `git push` of the run's `gardener/*` branch.
  2. `glab mr create --draft` for that branch, with `--label ephemeral-env` (it starts the MR's dev env).
  3. `glab mr update <IID> --description` on a `gardener/*` Draft MR that a gardener run opened. Never `--ready`,
     never labels, assignees, reviewers or any other field, never another MR.
  4. Amplitude, **development project `217854` only**, **only the gardener flag of the MR under test**, and only through
     the `lab-ab` agent: create it if it's missing (all weight on `not-using-<key>`), add one
     `gp:org_uuid is <that lab run's throwaway org uuid>` segment, and restore the segment list exactly as it was read.
     Never project `218297` (production), never another flag, never anything that reaches anyone but the throwaway org.
- **Still forbidden:**
  - Jira, Confluence and Datadog writes. Draft any ticket text in the artifact dir instead.
  - Pushing to `staging`, or running `push_to_staging.sh`. Staging is shared, so a human's push is the approval.
  - Adding or removing `ephemeral-env` after creation; running, retrying or cancelling pipelines. Restarting an env is the human's job.
  - Pushing to `master` or to any branch outside `gardener/*`. Merging. Marking the MR ready.
- Do not include in the change: migrations, new dependencies, changes in `frontend-workspaces/libs/` shared by other teams,
  or changes in `app/components/*/public/`. If the fix needs any of these, stop with outcome C (follow-up draft).
- Every behaviour change goes behind a new Amplitude kill-switch flag that **defaults OFF** (the established
  payroll pattern; see PRR-2418 `payroll-documents-history-pagination` and PRR-2414 `payroll-overview-hardening`).
  The MR states that the flag's **production** twin must be created in Amplitude before rollout.
- Stages run as subagents. After spawning one, end your turn; the harness wakes you with its result.
  Never poll for a subagent and never sleep. The one wait you run yourself is the dev-env wait in step 6, a bash loop with a deadline.

## Artifacts (the stage agents' contract)
`ART` is the **Task dir** of every stage: the RPI agents read and write numbered files there (`NN-<kind>-<description>.md`,
the newest of each kind wins). The ones this prompt reads:
- `ticket.md`, which you write
- `diagnosis.md`, from G1
- `NN-research-questions-*`, `NN-research-*`, `NN-design-discussion-*` and `NN-structure-outline-*`, from G2–G5
- `NN-review.md`, from G7
- `NN-lab-ab.md` and `lab-ab.result.json`, from G7.5
- `NN-pr-description.md`, from G8
- `handoff.md` and `digest.md`, which you write

To find the newest of a kind: `ls -La "$ART" | grep -- '-<kind>-'` and take the highest `NN`.

## 0. Preflight
```bash
cd /Users/tomasztrzaskoma/projects/housecall-web
# The launcher already fetched when GARDENER_FETCHED=1. Otherwise fetch master only.
# Never fetch everything, because it can take minutes. Do not wrap it in `timeout` (not installed on this Mac).
[ "$GARDENER_FETCHED" = 1 ] || git fetch origin master --quiet
mkdir -p ~/.pi/agent/gardener/runs
glab mr list --author=tomasz.trzaskoma --draft -F json 2>/dev/null | jq -r '.[] | select(.source_branch|startswith("gardener/")) | "\(.iid) \(.source_branch) \(.web_url)"'
git branch -r --list 'origin/gardener/*'
```
**WIP limit = 3** open `gardener/*` Draft MRs. If the limit is reached, do step 0.5 and the scoreboard (step 1) only, write the digest,
and stop with: "WIP limit reached. Review the open gardener MRs first."

## 0.5 Pending Lab A/B (fallback from earlier runs)
For each open `gardener/*` Draft MR whose description's Lab A/B block (between `<!-- gardener:lab-ab:start -->` and
`<!-- gardener:lab-ab:end -->`) says **pending**:
- Check its environment against the MR's head sha:
  - dev env: `~/.pi/agent/skills/verify-change/scripts/preflight.sh --target env --mr <IID> --checkout <its worktree> --sha <head>` passes
  - staging: `~/.pi/agent/skills/verify-change/scripts/wait-for-staging-deploy.sh <head> --once` exits 0
- **One serves it:** re-create the worktree from `origin/<branch>` if it's gone (step 2's commands, without `-b`), run G7.5
  for it (round 1), and replace only the Lab A/B block with the result (hard rule 3). A STOP here doesn't loop back; it goes in the
  digest for the human, with "do not mark ready".
- **Neither serves it:** leave it pending. After **3 working days** pending, change the block to
  `skipped: no approved environment served <sha>`. The digest asks the human to push it to staging or restart the env.

## 1. Score and pick
Read `~/.pi/agent/gardener/score.js` and run its **full contents verbatim** as one `codemode` script.
It returns `{pick, candidates, skipped, scoreboard, notInEpic}`.
- Forced story (`$@` = `PRR-xxxx`): use that story's scoreboard row.
- Otherwise take the first `candidates` entry that has **no** open `gardener/<lowercase key>-*` MR or remote branch.
- No candidate: write the digest (scoreboard + "nothing workable") and stop.
Write the scoreboard table (top 15) and `notInEpic` (report only) into the digest.

## 2. Setup
- `KEY` = the story key; `SLUG` = `<key lowercase>-rum-slo-gardener`; `BRANCH` = `gardener/<key lowercase>-rum-slo`;
  `WT` = `/Users/tomasztrzaskoma/projects/housecall-web-$SLUG`; `ART` = `/Users/tomasztrzaskoma/projects/housecall-web/.pi/plans/$SLUG`.
- If `WT` already exists from a failed run, remove it first (`git worktree remove --force`) and delete the local branch.
```bash
git worktree add "$WT" -b "$BRANCH" origin/master
(cd "$WT" && yarn install --frozen-lockfile --prefer-offline --silent) 2>&1 | tail -5
mkdir -p "$ART"
```
- Fetch the story from Jira (`getJiraIssue`, markdown). Write `$ART/ticket.md` with:
  - the story key and summary, and the view
  - the **live** scoreboard row, which replaces the stale June numbers in the story
  - the failing dimensions
  - the epic's DoD A/B/C
  - the story's investigation hints and its cluster mates

## 3. Diagnose (Datadog)
`subagent({ name: "G1 · Diagnose <KEY>", agent: "rum-diagnose", task: "Task dir: <ART>" })` → `diagnosis.md`

**Self-gate 1.** Read the `diagnosis.md` front matter.
- `dry-run`: write the digest and stop here.
- Continue to code only when `confidence: high` **and** `expected_outcome` contains `A`. A partial fix is fine:
  `A+C` means ship the code fix for the part we own and draft follow-ups for the rest.
  For `A+C`, also write `$ART/handoff.md` with the draft follow-up tickets. The MR description links to it.
- Otherwise (`confidence: low`, or only `B`/`C`): write `$ART/handoff.md`. It holds a draft Jira comment with
  the findings, plus either a draft Confluence page (outcome B) or draft follow-up tickets (outcome C).
  Then write the digest and stop. **No code.**
- If the diagnose subagent reports it has no Datadog access, **do not run its queries yourself.** Stop with outcome
  `error at diagnose: no MCP` so the config gets fixed.

## 4. RPI stages (chained, no human gates)
Every stage runs with `cwd: "<WT>"`, and its task message starts with `Task dir: <ART>. Mode: create.`.
Run each stage only after the previous one finishes.
1. `subagent({ name: "G2 · Questions", agent: "research-questions", cwd: "<WT>", task: "Task dir: <ART>. Mode: create. Ticket: <ART>/ticket.md. Live Datadog diagnosis: <ART>/diagnosis.md. These numbers are ground truth; questions should map the diagnosed culprits to code and gather the Rollout & CAB facts." })`
2. `subagent({ name: "G3 · Research", agent: "research", cwd: "<WT>", task: "Task dir: <ART>. Mode: create. Also read diagnosis.md: its Datadog numbers are ground truth, so do not re-guess them; map them to code with path:line." })`
3. `subagent({ name: "G4 · Design", agent: "design", cwd: "<WT>", task: "Task dir: <ART>. Mode: create. Gardener constraints: target the diagnosis primary_target first; the change must be behind a NEW default-OFF Amplitude kill-switch flag (name its key), with no migrations/dependencies/shared-lib/public-API changes; state the DoD outcome (A/B/C) explicitly; prefer the smallest change that moves the metric. Add a `## Lab A/B plan` section: the route(s), how to reach each state to compare, the masks for content that changes between runs on its own, the interaction to time when primary_target is inp, which visual changes (if any) are intended, and which signal must improve (cls → cls, api → failedRequests, err → errors; lt/inp → none in the lab)." })`
   **Unattended design questions.** The design discussion keeps its questions open for a human. If it has open ones, run G4
   once more with `Mode: iterate. Feedback: Unattended run: resolve every open design question with your recommendation, marked "(gardener default)". A question with no safe default stays open.`
   **Self-gate 2.** Stop and write `handoff.md` as in self-gate 1 when any of these hold:
   - a question is still open
   - the design has no A part (only B or C)
   - it depends on an excluded change category
   - it has no `## Lab A/B plan`
4. `subagent({ name: "G5 · Structure", agent: "structure", cwd: "<WT>", task: "Task dir: <ART>. Mode: create." })`
5. `subagent({ name: "G6 · Implement", agent: "implementation", cwd: "<WT>", task: "Task dir: <ART>. Mode: create. Implement the structure outline phase by phase. Commit on the current branch with messages prefixed [<KEY>]. Run the targeted jest specs, yarn lint:payroll (or the matching nx lint target), and check-types for the touched projects." })`
6. `subagent({ name: "G7 · Review", agent: "review", cwd: "<WT>", task: "Task dir: <ART>. Review the diff vs origin/master against the structure outline and the design discussion, read diagnosis.md too, and red-team the CAB answers." })`
   **Self-gate 3.** `NEEDS CHANGES` means re-run G6 with the findings ("address the newest NN-review.md findings"), then G7.
   Allow at most **2** fix rounds. If it is still not APPROVED: write `handoff.md` with the blockers, push nothing, and stop.

## 5. Draft MR (before Lab A/B, so the dev env can start)
```bash
cd "$WT" && git status --porcelain   # must be clean; commit leftovers only if they belong to the outline
git log --oneline origin/master..HEAD  # must be non-empty
git push -u origin "$BRANCH"
glab mr create --draft --source-branch "$BRANCH" --target-branch master --label ephemeral-env \
  --title "Draft: [$KEY] RUM SLO: <view> - <one-line change> (gardener)" \
  --description "$(cat "$ART/mr-interim.md")" --remove-source-branch --yes
```
`$ART/mr-interim.md` is a short interim description:
- the story, view and live scoreboard row
- the change in one paragraph
- the flag key
- the footer `🌱 Opened by Golden Signals Gardener. Draft, human review required.`
- this block:
```
<!-- gardener:lab-ab:start -->
**Lab A/B:** pending: waiting for the MR dev env. Don't mark ready yet.
<!-- gardener:lab-ab:end -->
```
Save the MR URL and `IID`. G8 replaces the interim description in step 7.

## 6. G7.5 · Lab A/B (in the same run)
Lab A/B verifies the change on the MR's dev env: flag OFF vs ON, the same build and the same throwaway org. For most gardener
changes the expected result is "nothing changed visually or functionally, and the targeted signal improved".

1. **Wait for the env**, at most **25 minutes**; it's usually up about 12 minutes after the MR. Run one bash loop, not a subagent:
   ```bash
   SHA=$(git -C "$WT" rev-parse HEAD); deadline=$(( $(date +%s) + 1500 ))
   until ~/.pi/agent/skills/verify-change/scripts/preflight.sh --target env --mr "$IID" --checkout "$WT" --sha "$SHA" >"$ART/lab-env-preflight.log" 2>&1; do
     [ "$(date +%s)" -lt "$deadline" ] || break; sleep 60
   done
   ```
   If the env never passes, check staging once with `wait-for-staging-deploy.sh "$SHA" --once`; it serves the sha only if a human pushed it.
   **No environment:** record the preflight output in the digest. Leave the MR's Lab A/B block as pending, with the reason
   (hard rule 3), go on to step 7, and step 0.5 of a later run picks it up.
2. **Run it:** `subagent({ name: "G7.5 · Lab A/B <KEY> r<round>", agent: "lab-ab", cwd: "<WT>", task: "Task dir: <ART>. Worktree: <WT>. MR: <IID>. Story: <KEY>. Flag key: <key>. Round: <round>. Target: env (or staging)." })`
   → `NN-lab-ab.md` + `lab-ab.result.json`

**Self-gate 4: on `lab-ab.result.json` `verdict`.**
- **PASS:** go on to step 7.
- **STOP:** loop back, the way `/rpi` loops a failed verify-change back to implementation:
  1. re-run G6: `Task dir: <ART>. Mode: iterate. Feedback: address the newest NN-lab-ab.md fixes. Nothing may change visually or functionally unless its Lab A/B plan says so.`
  2. re-run G7 and self-gate 3
  3. `git push` the branch; the env syncs a push in about 30 s
  4. repeat the wait in step 6.1 with the new `SHA`, then run G7.5 with `Round: <n+1>`

  `/rpi` doesn't cap this loop, because a human approves each round. Unattended, use the same cap as self-gate 3: at most
  **2** fix rounds. After that, replace the Lab A/B block with ❌ and the newest `NN-lab-ab.md` summary (hard rule 3), write
  `handoff.md` with the remaining fixes, keep the MR draft, write the digest with outcome `lab blocked`, and stop.
- **INCOMPLETE:** don't loop. Put the reason in the Lab A/B block and the digest, then go on to step 7. An
  `INCOMPLETE` whose reason is a flag restore that didn't match goes at the **top** of the digest.

## 7. Describe and update the MR
`subagent({ name: "G8 · Describe", agent: "describe-pr", cwd: "<WT>", task: "Task dir: <ART>. Read the newest NN-review.md, NN-lab-ab.md and diagnosis.md too. Add a 'Golden signals evidence' section: the live scoreboard row, the diagnosed dominant cause with numbers and Datadog links, the expected metric movement, and the Lab A/B result (compare.md's tables, the flag proof, diff image paths) inside the block <!-- gardener:lab-ab:start --> … <!-- gardener:lab-ab:end -->, with 'Mark ready when Lab A/B is PASS, or SKIPPED and you've checked it yourself.' State the flag's production twin must be created in Amplitude before rollout. Footer: '🌱 Opened by Golden Signals Gardener. Draft, human review required.'" })`
→ `NN-pr-description.md`. Then:
```bash
glab mr update "$IID" --description "$(cat "$ART/<newest NN-pr-description.md>")"
```

## 8. Digest (always, also when stopping early)
Append to `~/.pi/agent/gardener/runs/$(date +%F).md` and copy it to `$ART/digest.md`:
- Outcome: one of
  - `MR opened <url> (lab PASS | lab pending | lab INCOMPLETE: <reason>)`
  - `lab blocked <url>`
  - `handoff (B/C)`
  - `low confidence`
  - `review blocked`
  - `WIP limit`
  - `error at <stage>`
- Lab A/B lines from step 0.5 for earlier MRs: their result, or how long they've been pending.
- Story, view, score, failing dims, and why this story was picked (rank, skipped above it).
- Dominant cause, one line per dimension, with numbers.
- What changed, the flag key, and the Lab A/B verdict with its key numbers (before → after).
- For the human:
  - create the flag's production twin in Amplitude
  - paste the CAB answers from `NN-pr-description.md` into Jira
  - assign the story
  - mark ready only on Lab A/B PASS
  - re-measure 7 days after rollout
- Scoreboard top 15 and the `notInEpic` list.

Finish with the digest's outcome line as your final message.
