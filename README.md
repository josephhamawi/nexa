# Nexa

**Your AI operations agent.** Tell Nexa what you need, and it researches, monitors
websites, runs browser workflows, manages recurring tasks, analyses what it finds,
and reports back through the desktop app and Telegram.

Nexa is not a chat window. It plans, acts, verifies and reports.

```
You:   Find 5 remote AI engineering jobs that match my profile.
Nexa:  Task created: remote AI engineering jobs
       Plan (AI-planned):
       1. Search for roles matching your profile
       2. Rank them against your skills and salary floor
       3. Send the shortlist
       I will report back when it is done.
```

---

## What it does

- **Understands a request** in plain language, from the desktop app or Telegram.
- **Plans** it into concrete steps with a named tool for each one.
- **Acts**: searches the web, reads pages, drives a real browser, reads approved folders.
- **Watches** pages and searches on a schedule, reporting only meaningful change.
- **Asks** before anything consequential, and stops for a human when a site does.
- **Reports** with evidence: URLs, timestamps, screenshots, extracted data.
- **Survives restarts**: tasks, schedules and watchers are on disk, not in memory.

### What it will not do

- Solve or bypass CAPTCHAs, Cloudflare challenges or any other human check.
- Enter your passwords. When a site needs a login, it hands you the browser.
- Read outside the folders you have explicitly allowed.
- Claim something was done when it was not.

When a page needs a person, the task moves to `WAITING_FOR_HUMAN`, Nexa screenshots
the state, messages you, and waits. You finish the step, press **Resume**, and it
carries on from where it stopped.

---

## Architecture

```
            You  (desktop UI / Telegram)
             |
        NexaAgent            orchestration, one entry point for every request
             |
          Planner            language -> plan (LLM, with a rule-based fallback)
             |
   TaskEngine   WatcherEngine   state machines, retries, scheduling, recovery
             |
        ToolRegistry         permission-checked capabilities
             |
  web_research  browser  watcher  analyze  files  notify
             |
      Evidence + Results -> desktop + Telegram
```

```
src/
  agent/        NexaAgent (orchestrator), Planner, ActivityLog
  tasks/        Task model + state machine, TaskEngine
  watchers/     Watcher model + change detection, WatcherEngine
  tools/        Tool interface, registry, and the six built-in tools
  llm/          Provider interface, Anthropic, OpenAI-compatible, null
  browser/      BrowserManager (profiles, locking), ChallengeDetector
  mcp/          MCP client (JSON-RPC over stdio) and tool adapter
  telegram/     TelegramBot: long polling, commands, inline buttons
  notifications/ Telegram, desktop, sound
  evidence/     Screenshots and captured payloads
  storage/      Durable JSON stores
  config/       Zod schema, config and secret handling
  main/         Electron main process, IPC, preload
  ui/           Dashboard (plain HTML/CSS/JS, context-isolated)
  cli/          agent, doctor, test:telegram
```

Design decisions worth knowing:

- **The task state machine is real.** Every transition is declared and checked;
  an illegal one throws rather than corrupting state. Crash recovery is an
  explicit `RUNNING -> QUEUED` edge, not a silent reset.
- **Permissions are per task.** A tool declares what it needs (`RESEARCH`,
  `BROWSER`, `FILES`, `NOTIFY`, `EXECUTE`); the engine refuses any step whose
  tool asks for more than the task was granted. The model choosing a tool cannot
  widen its own access.
- **Nexa yields to you.** It watches for navigations and form posts it did not
  make. While you are using the browser, scheduled work waits instead of
  navigating the page out from under you.
- **One browser profile, one process.** A PID lock stops two instances sharing a
  profile directory, which would otherwise log each other out of sites.
- **No provider, no problem.** Without an API key the planner falls back to rules
  and the app still creates watchers, runs schedules and drives browsers.

---

## Installation

Requires **Node.js 20.10+**.

```bash
cd nexa
npm install          # also runs "playwright install chromium"
cp .env.example .env
npm run dev          # build and open the app
```

`config.json` is created from `config.example.json` on first run.

---

## Environment variables

Secrets live in `.env` (owner-only, gitignored) and never in `config.json`.

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your numeric chat id; **only this chat may command Nexa** |
| `ANTHROPIC_API_KEY` | Anthropic provider |
| `OPENAI_API_KEY` | OpenAI or any compatible server |
| `OPENAI_BASE_URL` | Base URL for Ollama, vLLM, LM Studio, … |
| (per server) | MCP servers may need their own tokens; set them in that server's `env` block in `config.json` |
| `LOG_LEVEL` | `trace` … `fatal`, default `info` |

All of these can also be set from **Settings** in the app, which writes them to
`.env` with `chmod 600`. They are never displayed again and never logged.

---

## AI provider setup

Settings → AI provider. Pick Anthropic or an OpenAI-compatible endpoint, set a
model, paste a key.

The provider is used for planning, tool selection, ranking, summarising and
writing reports. Without one, Nexa plans with rules: it still handles "watch
this page", "research X", "do it every morning", and browser workflows, but
loses free-form phrasing and model-quality summaries. `npm run doctor` tells you
which mode you are in.

---

## Telegram setup

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, copy the token.
2. Message [@userinfobot](https://t.me/userinfobot) for your numeric chat id.
3. Send your own bot one message so it is allowed to write to you.
4. Paste both into Settings → Telegram and press **Save and verify**.

Telegram then becomes a full remote control:

```
Find 5 interesting remote AI jobs and send me the results.
Do that every morning at 8am.
Watch https://example.com/pricing and tell me when it changes.
Show me my active tasks.
Pause the job search.
Resume it.
Stop everything.
```

Commands also work: `/start /help /status /tasks /watches /pause /resume /cancel`.

Approvals and takeovers arrive as inline buttons: **Approve / Reject**, or
**Open browser / Resume / Cancel**.

Messages from any chat id other than yours are refused.

---

## MCP servers: borrowing capabilities

Nexa is an MCP client. Any [Model Context Protocol](https://modelcontextprotocol.io)
server becomes a set of Nexa tools, which is how it reaches things it does not
implement itself: your filesystem, git, databases, issue trackers, Slack.

Add them to `config.json` and restart:

```json
{
  "mcpServers": [
    {
      "id": "files",
      "name": "Filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Documents"],
      "permissions": ["FILES"]
    },
    {
      "id": "git",
      "name": "Git",
      "command": "uvx",
      "args": ["mcp-server-git", "--repository", "/Users/you/code/project"],
      "permissions": ["FILES", "EXECUTE"]
    }
  ]
}
```

Their tools appear to the planner as `mcp_<server>_<tool>` and are usable in any
task. Settings → MCP servers shows what connected and how many tools each
contributed.

**The safety model does not loosen for them:**

- Each server runs under the `permissions` you grant it. A filesystem server
  given `FILES` cannot drive the browser, whatever its tools claim.
- A tool is assumed to **write** unless the server explicitly marks it
  read-only, so it goes through the approval gate. Guessing "harmless" would
  quietly skip the prompt.
- The command and arguments come from `config.json` only. Nothing the model
  produces is ever executed as a shell command; it can only call tools a
  server already advertises.
- A server that dies or times out fails that step. It cannot hang a task.

Verified against the official filesystem server: 14 tools discovered, schema
converted, `read_file` correctly detected as read-only, call executed and
content returned.

---

## How agentic is it?

Nexa plans, acts, and then **checks its own work**:

1. The planner turns your request into steps, choosing from every registered
   tool, MCP ones included.
2. The engine runs them, retrying transient failures and stopping for a human
   when a site or a consequential step needs one.
3. Before a task is called done, the agent reviews what it actually got against
   what you asked for. If the result clearly misses, it appends up to three
   more steps and continues.

That last part is bounded on purpose (`maxAdaptiveSteps`, and only with a model
configured). An agent that can extend its own plan without limit is one that
runs up a bill and never finishes.

What it will not do is pretend. A request needing a capability Nexa lacks is
refused with the gap named, rather than quietly degraded into a web search.

---

## Browser profiles

Each profile is a separate persistent browser session with its own cookies,
stored under `data/profiles/<id>/`. Sign in once in a profile and later tasks
reuse that session.

Nexa runs stock Chromium with no stealth plugins and no fingerprint patching.
When a site blocks automation, that is treated as a signal to ask you, not a
problem to engineer around.

---

## Task examples

| Ask | What Nexa builds |
| --- | --- |
| "Research the latest AI agent frameworks and summarise" | search → analyse → report |
| "Find 5 remote AI jobs that match my profile" | search (profile-aware) → rank → report |
| "Watch example.com/pricing and tell me when it changes" | watcher, every 6h, keyword-filtered |
| "Open example.com every Friday and send me the headlines" | browser workflow, weekly |
| "Summarise new documents in my notes folder" | file scan → analyse → report |
| "Every morning at 8am send me an AI news brief" | recurring research task |

Your profile (Settings → Your profile) feeds the career and learning tasks:
skills, technologies, preferred and excluded roles, remote preference, salary
floor. Nothing is hard-coded.

---

## Watcher examples

A watcher stores a normalised snapshot and compares future readings against it.

It **ignores**: timestamps, relative times ("5 minutes ago"), session ids,
UUIDs, hashes and cache-busting query strings. It **reports**: genuine content
changes, optionally filtered to keywords so an unrelated edit on a busy page
stays quiet.

```
watch https://example.com/pricing and tell me when the price changes
```

First check is a baseline, never an alert. The interval floor
(`agent.minWatchIntervalSeconds`, default 300s) applies to every watcher, and an
over-eager request is raised to it rather than accepted.

---

## Security

- Telegram is restricted to your chat id; anything else is refused and logged.
- Secrets are environment-only, written `chmod 600`, never echoed to the UI.
- The logger redacts passwords, tokens, cookies, API keys and OTPs at every
  nesting level; URLs are logged with query strings stripped.
- The file tool refuses any path outside your allowed folders, traversal
  included, and declines binary formats rather than returning garbage.
- Tasks carry explicit permissions; a tool needing more is refused.
- Mutating steps require approval when `requireApprovalForWrites` is on.
- The renderer runs with context isolation, no Node integration, and a strict
  CSP (`default-src 'none'`). Its only capability is the IPC surface in
  `src/main/preload.ts`, and evidence files open only from Nexa's own directory.

---

## Demo mode

Settings → Agent behaviour → Demo mode. Nexa plans and executes exactly as
usual, but research and browser steps are simulated locally and **every result is
labelled `[SIMULATED]`**. Nothing is contacted.

It exists to demonstrate the whole flow — natural-language task creation,
planning, execution, analysis, notification, approval, takeover, history and
evidence — without depending on the network. Simulated output is never presented
as real.

---

## Development

```bash
npm run dev           # build and launch the desktop app
npm run build         # compile TypeScript, copy UI assets
npm start             # launch from an existing build
npm run agent -- "…"  # run one request headlessly, follow it to completion
npm run doctor        # what is configured, what is missing
npm run test          # unit tests (no network)
npm run lint          # ESLint
npm run typecheck     # tsc --noEmit
npm run package       # build a distributable desktop app into release/
```

Adding a tool is the main extension point: implement the `Tool` interface
(`name`, `description`, `inputSchema`, `permissions`, `mutating`, `execute`) and
register it in `NexaAgent.registerTools()`. The planner picks it up
automatically, because its catalogue is generated from the registry.

---

## Testing

```bash
npm test
```

99 tests across the task state machine, recurrence maths, watcher change
detection and noise filtering, the planner (control intents, rule planning,
schedule parsing), the task engine (retries, approvals, takeover, permission
refusal, crash recovery), the tool registry, the file sandbox, Telegram
send/receive/button handling and token redaction, MCP schema conversion,
permission inheritance and error handling, page-boilerplate stripping and
extractive summarisation, and JSON extraction from model output.

Tests run against a scratch data directory and stubbed network. **No test
contacts the internet.**

The restart scenario is covered explicitly: create a task, simulate a crash
mid-run, build a fresh engine over the same files, confirm the task survived,
was requeued, and then completes.

---

## Roadmap

**Now**: task engine, orchestrator, watchers, browser workflows, Telegram
control, approvals, human takeover, evidence, persistence, demo mode.

**Next**: richer file intelligence (PDF and DOCX), agent memory across tasks,
multiple concurrent tasks, more watcher types, a daily briefing digest.

**Later**: the architecture is deliberately local-first, but the layering
(agent → engines → tools) is designed so execution could move to a remote
worker, with multiple users and shared workflows, without rewriting the core.
