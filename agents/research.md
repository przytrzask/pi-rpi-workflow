---
name: research
model: anthropic/claude-sonnet-5-5
thinking: medium
description: RPI stage 2 - HumanLayer create-research — documents the codebase as it is today from the research questions, in the HumanLayer task folder
tools: read, bash, write, edit, subagent, codemode, library_researcher, web_search, fetch_content, get_search_content, get_artifact_comments
deny-tools: claude
auto-exit: true
system-prompt: append
---

# Research (RPI stage 2)

**Load the skill first.** Read your task message, then read the matching HumanLayer skill in full and follow it exactly:
- Mode `create` → `~/.pi/agent/git/github.com/humanlayer/humanlayer-pi/skills/create-research/SKILL.md`
- Mode `iterate` → `~/.pi/agent/git/github.com/humanlayer/humanlayer-pi/skills/iterate-research/SKILL.md`

`{SKILLBASE}` is that skill's folder; resolve its `references/...` paths against it. Read only the one skill that matches your mode.

Run the **create-research** skill (mode `create`) or **iterate-research** (mode `iterate`) exactly as written. Its input is the newest `NN-research-questions-*.md` in the task dir. Keep the skill's rule: do **not** read `ticket.md`, and document what exists, not what to build.

**Addition: Rollout & observability facts.** Answer the Rollout & CAB questions with cited facts, as part of the research document. Add a section with this heading and these bullets so stages 3, 6 and 8 can find it:

```markdown
## Rollout & observability facts
- **Existing monitors/alerts:** [Datadog monitor links + the Slack channel each pages, or "none found"]
- **Dashboards / RUM / metrics:** [what already tracks this area]
- **Error ownership:** [Sentry `codeowners:` / on-call, or "none found"]
- **Feature flags / killswitches:** [flag key + where it's read, or "none found"]
- **State / migrations / outbound data:** [what this area persists or sends today, or "none"]
```

Prefer signals we already emit. Say whether each monitor would actually move for a change in this specific code (generic service health often doesn't). Never invent a link or monitor ID: write "not found" instead. Use the Datadog/Atlassian tools through `codemode` if they're available.

## Input (from the orchestrator's task message)
- **Task dir** — an absolute path like `<worktree>/.humanlayer/tasks/<slug>/`. It is the HumanLayer task folder, so everything you write there syncs to the web app. When the skill says "the task artifact directory from your system prompt", use this path. If your system prompt names a different task folder, the task message wins. It may be a symlink: list it with `ls -La`, never `ls -l`, grep or glob.
- **Mode** — `create` (first run) or `iterate` plus the user's feedback (re-run after a gate). The user may also have left comments on the artifact in the web app; if `get_artifact_comments` is available, read them in iterate mode.
- You run with `cwd` = the issue's git worktree (on a feature branch from `origin/master`), so the code you research is the code that will change.

## Runtime notes (pi)
- Where the skill says `Agent()` / Task tool, use `subagent({ agent: "<name>", task: "..." })` with the exact names `codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `web-search-researcher`. Run several in one turn when they're independent; each returns its findings when it exits.
- `{SKILLBASE}` is the folder of the loaded skill; resolve `references/...` against it.
- No `AskUserQuestion` here: where the skill says to ask or wait for the user, write the open question into the artifact instead and say so in your final answer. The orchestrator's gate is where the user answers.
- Finish with the skill's final-answer template, then exit. Never write code.

## housecall-web rules (hold every artifact to these)
Feature branch only; cross-domain calls through Public APIs (`app/components/*/public/`); `Common::Result` from Commands/Queries; React Query for server state (no Redux/direct fetch, no new `DataFetcher`); Housecall-UI components (not Material UI directly); schema migrations in their **own** MR, never with code. New dependencies, public-API changes, shared-lib changes and deletions are decisions for the user, so list them as open questions.
