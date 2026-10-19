# my-teams-channel

A Microsoft Teams test harness built on `@copilotkit/channels`. Every module
under `src/features/` is transcribed from one CopilotKit docs page;
`src/channel.tsx` composes them into a single Channel.

## Layout

```
src/
├── index.tsx              Server + runtime bootstrap (entry point)
├── channel.tsx            createChannel(...) + all handler registrations
├── agent.ts               Per-conversation agent factory
├── env.ts                 required() env reader
├── features/              One file per docs page
│   ├── tools.tsx                  /teams/tools
│   ├── identity-and-memory.tsx    /teams/identity-and-memory
│   ├── rich-messages.tsx          /teams/rich-messages
│   ├── interactive.tsx            /teams/interactive
│   ├── commands-and-reactions.tsx /teams/commands-and-reactions
│   ├── files-and-multimodality.ts /teams/files-and-multimodality
│   └── threads-and-state.ts       /teams/threads-and-state
├── diagnostics.ts         withErrorLogging() — unredacts handler errors
└── services/
    └── fixtures.ts        STUBS — replace with your real services
```

Feature modules export reusable units (tools, components, schemas, helpers).
They never register handlers on the Channel themselves, with one exception:
`registerReactionHandlers(channel)`, because `onReaction` takes a filter.

`channel.tsx` owns the single `onMessage` handler. The SDK runs *every*
registered `onMessage`, so a second registration would run the agent twice on
the same turn. `onMention` is deliberately left unregistered so channel
@mentions fall back to that same path.

## Run — ONE process

The agent is `BuiltInAgent`, which runs in-process. The LangGraph Deep Agent in
`../my-deep-agent` is present but **not wired up** — its `interrupt()` deadlocks
this Intelligence project. See `src/agent.ts` for the full reason and the steps
to switch back.

```bash
npm install
npm start          # wait for: Teams Channel online
```

`.env` needs `INTELLIGENCE_API_KEY` and `CHANNEL_CODE`.
`LANGGRAPH_DEPLOYMENT_URL` is set but unused until the graph is re-wired.

Pipe to a file when you need to share output: `npm start 2>&1 | tee run.log`.

```bash
npm run typecheck  # tsc --noEmit
npm run dev        # tsx watch
```

## Test prompts

Message the bot in a 1:1 chat, or @mention it in a team channel.

Managed Teams does **not** interpret `/name` prefixes — leading-slash text
arrives as ordinary message content — so `/card` and `!card` are equivalent.
The `!` aliases exist only for parity with the Slack harness.

### Tools and context — `/teams/tools`

| Prompt | Expect |
| --- | --- |
| `give me incident summary` | Calls `get_incident`, replies with INC-421 status |
| `show me incident INC-421` | Calls `show_incident`, posts an Adaptive Card |
| `what is the support policy?` | Answers from channel `context` (never disclose credentials, escalate Sev-1) |
| `what platform am I on?` | `teams` — from per-turn context |

### Identity and Memory — `/teams/identity-and-memory`

| Prompt | Expect |
| --- | --- |
| `List my approvals` | **The real identity test.** Linked → `APR-1 — INC-421 rollback`. Unlinked → the tool does not exist for that turn |
| `!subject` | Posts the `subject: "initiator"` resume demo card |

`List my approvals` is the sound test because `list_my_approvals` is
*conditionally registered*: an unlinked actor never sees the tool at all.
Prefer it over `who am i?`, which the model tends to answer from profile
metadata in the message body rather than from the resolved application user.

**Link your account first.** `linkedAccounts` in
`src/features/identity-and-memory.tsx` ships with the docs' placeholder key
(`teams:tenant-123:user-456`), which matches nobody. Send one message and copy
the real key from the log line:

```
[identity] teams:<tenant>:<actor> -> null (unlinked)
```

Unlike Slack, the Teams key **includes the tenant** and that segment is
load-bearing. If the log shows `unknown` as the tenant, a warning fires and the
code falls back to an unscoped key — do not attach a second Microsoft tenant
while that is true.

Clicking `!subject`'s button without an active continuation raises
`ChannelContinuationRequiredError`; that is expected for a standalone post.

### Rich messages — `/teams/rich-messages`

| Prompt | Expect |
| --- | --- |
| `!card` | Card reading **`INC-421 · Investigating`** |
| `!digest` | Adaptive Card 1.5 `Table` + a donut `Chart` |
| `!triage` | Form card: severity dropdown, note field, **Submit triage** |

`!card` is posted as `Loading`, then updated in place. If the update had failed
you would be left looking at `Loading` — that is the proof.

`!digest` exercises the two nodes with the most provider variance. A Teams
client that does not support chart extensions **omits the chart** — the
`Context` footer carries the same number in text, as the docs require.

`!triage` is the Teams-only submit path: `Select` and `Input` render as
`Input.ChoiceSet` / `Input.Text` in the card body, and only the Button's
`Action.Submit` fires a handler, receiving the named fields in `ctx.values`.
`Select.onSelect` and `Input.onSubmit` are **not** dispatched on Teams, so this
harness deliberately does not define them. Watch for the `[triage] submission`
log line.

### Interactive / approvals — `/teams/interactive`

| Prompt | Expect |
| --- | --- |
| `request approval to roll back INC-421` | Card with **Approve** / **Reject** |
| *click a button* | Card flips to Approved/Rejected, agent acknowledges the decision |

⚠️ **The click cannot complete on this project.** The card posts, Teams reports
"Your response was sent to the app", and then `thread.resume()` fails with
`THREAD_NOT_FOUND` — see Known limitations. The card also will not flip to
"Approved", because Teams interaction deliveries carry no `messageRef`, so
`message.ref.id` is empty and the update is correctly skipped.

`BuiltInAgent` never emits `on_interrupt`, so `channel.onInterrupt` — registered
exactly as documented — does not fire. The `request_approval` channel tool posts
the same registered card from inside the run, binding the same continuation. See
the comment block in `src/features/interactive.tsx`.

A click arrives as an **interaction**, not a message, so it shows **no
`[delivery] -> onMessage` line**. One click per card: the continuation is one-use.

Complete an approval within one run of the process — `store.adapter` is unset,
so a card from before a restart gives "action expired".

### Commands and reactions — `/teams/commands-and-reactions`

| Action | Expect |
| --- | --- |
| `/triage customer` | Arrives as ordinary text; managed Teams never dispatches it as a command |
| react 👀 to a bot message | *"…marked this response for follow-up."* + `[audit]` line |
| remove the 👀 | *"…removed the follow-up marker."* (`added: false`) |
| react 🔥 | `[audit]` line only, **no message** — the emoji filter working |
| react 👍 | `[audit]` shows `emoji: 'thumbs_up'` normalized, `rawEmoji` keeps the Teams token |
| `!feedback` then react 👍 to that card | *"Thanks for the feedback."* |
| `!feedback` then react anything else | *"Reaction update received."* |
| `!react` | Bot adds and removes its own 👀 |

Reacting 👀 to a `FeedbackCard` posts **twice** — the global handler and the
per-message handler both fire. That is the SDK's design, not a bug.

**`!react` may legitimately fail.** Outbound reactions use Microsoft's
public-preview reaction API; a tenant that cannot use it leaves `react()`
returning `{ ok: false }` rather than throwing. `toggleOwnReaction` checks the
result and reports the error instead of failing silently.

Teams classic reactions (Like, Heart) and recognized modern emoji tokens are
normalized to the SDK's portable names by the same handler.

### Files and multimodality — `/teams/files-and-multimodality`

| Action | Expect |
| --- | --- |
| upload an image + `what is in this image?` | Model receives hydrated `contentParts` |
| upload a PDF + `summarise this` | Same, as a `document` part |
| `!report` | Bot posts `incident-report.csv` |

Inbound and outbound files are capped at 25 MiB.

**Test uploads in both surfaces.** Personal chats deliver downloadable
attachments directly; team channels go through SharePoint references and
Microsoft Graph. A channel upload needs the `ChannelMessage.Read.Group`
resource-specific consent, granted by a **team owner** at install time. The
optional `Files.Read.All` permission enables SharePoint retrieval — without it
attachments simply go missing rather than the Channel failing.

Attachments are forwarded to the model unvalidated. See the security block at
the bottom of `src/features/files-and-multimodality.ts` before accepting real
uploads.

### Threads and state — `/teams/threads-and-state`

Run in order, in **one** conversation:

| Prompt | Expect |
| --- | --- |
| `!state` | `No state stored for this conversation yet.` |
| `hi` | Normal reply — this runs `advanceTriage` |
| `!state` | `Thread state: {"incidentId":"INC-421","stage":"triage"}` |
| `!state resolved` | ``Stage set to `resolved`.`` |
| `!state` | `…"stage":"resolved"` |
| `!state bogus` | `Rejected by the state schema: … expected one of "triage"\|"awaiting-approval"\|"resolved"` |

Then:

- **New Teams conversation** → `!state` reports nothing. State is keyed by
  `conversationKey`.
- **Restart the process** → state is gone. Correct: MemoryStore, not durable.
- **Install into a new team** → `onWelcome` posts `Welcome, <name>.`
- **Ask a follow-up question** → managed history is restored per turn,
  separately from `thread.state()`.

## Known limitations

- **No durable `StateStore`.** The docs' snippet passes
  `adapter: durableStateStore`, but never defines it — it is a placeholder for
  your implementation. This harness leaves `store.adapter` unset and runs on the
  default MemoryStore, so thread state, interactive-action snapshots, and
  per-message reaction callbacks are process-local. Approval cards do not
  survive a restart.
- **Every card renders twice** — an upstream managed-path bug.
  `teamsMessageEffect` (`@copilotkit/channels-intelligence`, delivery-adapter.js)
  sets the activity's `text` unconditionally *and* attaches the Adaptive Card, so
  Teams shows a markdown projection above every card. Button labels appear there
  as backtick code spans, which look like buttons but are inert — only the card's
  `Action.Submit` buttons dispatch. The direct Teams adapter renders either/or
  (`isPlainText(ir) ? { text } : { card }`); the managed path does not. No
  `createChannel` option suppresses it. The `raw` escape hatch would (a raw-only
  post leaves `text` empty) but is unusable for interactive cards: the action
  registry stamps `ckActionId` into `data` at post time, and hand-written JSON
  cannot carry an id the registry ever issued.
- **Approvals cannot complete.** Intelligence has no thread for this project
  (`GET /api/threads?userId=…` returns zero for every id), and interaction
  deliveries load history from the threads API rather than the Teams transcript
  (`input.kind === "text"` is the only branch that uses the transcript). So every
  card click 404s in `loadHistory`. This is agent-independent — `thread.resume()`
  takes that path no matter what posted the card. Needs CopilotKit to enable
  thread persistence on the project.
- **Cards never flip on click.** Teams interaction deliveries carry no
  `messageRef`, so core substitutes `{ id: "" }` and the documented
  `message.ref.id` guard skips the update. A ref cannot be cached from the
  original post either: it holds a live `claimedDelivery` handle, which is not
  JSON-serializable and belongs to a delivery that has already closed.
- **The Deep Agent is unwired on purpose.** `../my-deep-agent` works (the graph
  compiles, runs in ~2s, and interrupts correctly), but its `interrupt()` cannot
  be resumed here, so the LangGraph thread stays suspended at `next: ["tools"]`
  and every later message replays the same stale approval card. One failed
  approval permanently wedges the conversation. `src/agent.ts` documents the
  switch-back steps; it also needs `OPENAI_API_KEY` in `../my-deep-agent/.env`.
- **`src/services/fixtures.ts` is stubbed** — `incidents`, `approvals`, `audit`,
  `feedback`, `triage` are placeholders. Replace before real use.
- **Modal callbacks are direct-adapter only** and are not wired here.
  `postEphemeral`, conversation titles, and suggested prompts may return
  `{ ok: false }` on managed Teams.
- **Diagnostics are on.** `[identity]` logs provider account IDs and
  `[delivery]` traces every handler. Strip both before production.

## Diagnostics

Every `[delivery] ->` must get a matching `<-`; an unmatched one is a leaked
slot (8 concurrent max), which Intelligence reports as
`channel_delivery_stalled`.

The SDK redacts handler errors to a bare `errorCategory`. `withErrorLogging` in
`src/diagnostics.ts` prints the real one.

The dashboard's **Delivery failing** badge tracks whether a runtime is connected
*right now* — it goes red every time you stop the process. The **History** tab is
the real record of delivery outcomes. "Online" never proves that your workflow
state survives a restart.
