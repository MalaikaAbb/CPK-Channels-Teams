# channels-teams

A Microsoft Teams test harness for the CopilotKit Channels SDK. Every feature is
transcribed from one of the seven `docs.copilotkit.ai/teams/*` pages, wired into
a single Channel so they can be exercised against a real tenant.

```
channels-teams/
├── my-teams-channel/     Channels SDK listener (Teams side)  [ACTIVE]
└── my-deep-agent/        LangGraph Deep Agent                [not wired up]
```

**One process today.** The Channel runs `BuiltInAgent` in-process and owns Teams,
tools, UI, state, and identity.

The Deep Agent is complete and working, but deliberately unwired: its
`interrupt()` cannot be resumed on this Intelligence project, which leaves the
LangGraph thread suspended and makes the bot replay the same approval card for
every subsequent message. `my-teams-channel/src/agent.ts` documents the deadlock
and the steps to switch back once thread persistence is enabled.

---

## Setup and run

```bash
cd my-teams-channel && npm install
npm start                                # wait for: Teams Channel online
```

`my-teams-channel/.env` is already configured (`INTELLIGENCE_API_KEY`,
`CHANNEL_CODE`).

To bring the Deep Agent back later, follow `my-teams-channel/src/agent.ts`, set
`OPENAI_API_KEY` in `my-deep-agent/.env`, and start it **first** on :8123:

```bash
cd my-deep-agent && npm install && npm run dev
```

Do not re-wire it until `GET /api/threads?userId=<appUserId>` returns a thread
for the conversation — while it returns none, every approval click 404s and the
graph deadlocks.

See [my-teams-channel/README.md](my-teams-channel/README.md) for the per-page
test prompts, expected output, and known limitations.

---

## Provisioning note

`npx copilotkit@latest channels add --adapter teams --provision` can fail with
`CLI_TEAMS_LOGIN_REQUIRED` even when the browser reports a successful sign-in.

Cause: npx installs dependencies with lifecycle scripts disabled, so `keytar`'s
`install` script never runs, `@azure/msal-node-extensions` fails to import, and
`@microsoft/teams.cli` silently falls back to an **in-memory** MSAL cache. The
token is gone by the time the CLI shells out to `teams status --json`.

Fix, inside the npx cache (no compiler needed):

```bash
cd ~/.npm/_npx/<hash>/node_modules/keytar && node ../prebuild-install/bin.js
```

It recurs on every `copilotkit` version bump, because npx re-installs into a
fresh version-keyed cache directory. `npm i -g copilotkit` avoids it — global
installs do run lifecycle scripts. Native Linux only; the WSL code path uses a
plain file cache and is unaffected.

## Tenant

This Channel is provisioned single-tenant against
`4a9a274f-28cb-48eb-9c3d-f9614979e2dd`. Managed Teams currently reports
`tenant.id === "unknown"` to `identifyUser`, so account links are keyed on the
actor MRI alone and cross-tenant isolation is **not** enforced. See the guard in
`my-teams-channel/src/features/identity-and-memory.tsx` — it refuses actors from
any other tenant the moment Intelligence starts sending one.
