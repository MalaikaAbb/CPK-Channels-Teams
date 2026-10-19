# Managed Teams Channel — five findings

Environment: `@copilotkit/channels@0.6.1`, `@copilotkit/runtime@1.65.0`,
Node 24.16.0, Linux. Intelligence project **2199**, channel `teams-qa`
(`channel_01a023f5-decb-7b2f-9f23-d5b97f4be20d`). Tenant
`4a9a274f-28cb-48eb-9c3d-f9614979e2dd`.

Finding 1 is a hard blocker: **interactive approvals cannot complete on this
project.** The rest are correctness/documentation issues found alongside it.

---

## 1. BLOCKER — every card interaction 404s in `loadHistory`

**Symptom.** Clicking an Adaptive Card button posts back successfully ("Your
response was sent to the app"), then the delivery fails. The agent never
resumes.

```
{ status: 404,
  body: '{"error":{"code":"THREAD_NOT_FOUND","message":"Thread not found.", ...}}',
  path: '/api/threads/8c510f75-8c30-4df8-937b-f7dff7b0b715/messages?userId=teams%3A4a9a274f-…%3A29%3A1fQp8…'
} Intelligence platform request failed
{ meta: { deliveryId: 'dlv_01a02459-fb4a-7355-8df0-cc1bccd31d90', errorCategory: 'unknown' } }
```

Dashboard records it as `provider_call_failed`.

**Mechanism.** Only text turns read history from the provider transcript.
Everything else falls through to the Intelligence threads API —
`@copilotkit/channels-intelligence/dist/delivery-adapter.js:53`:

```js
const providerHistory = target.delivery.turn.input.kind === "text"
    ? await this.loadProviderAgentHistory(target)
    : undefined;
const history = providerHistory?.messages ?? (await this.options.loadHistory({...}));
```

A button click is `input.kind === "interaction"`, so it always takes
`loadHistory` → `GET /api/threads/{canonicalThreadId}/messages`.

**Root cause.** That project has no threads at all:

```
GET /api/threads?userId=teams%3A4a9a274f-…%3A29%3A1fQp8…   → 200, threads: 0
GET /api/threads?userId=user_42                            → 200, threads: 0
```

Text turns never create one (they use the transcript), and the channel path has
no `getOrCreate` — `getOrCreateThread` exists in the platform client but is only
called by the HTTP run handler, not by channel deliveries. So the thread the
interaction path requires is never created by any code path we can reach.

Possibly related: `GET /api/memories` on the same project returns
`403 MEMORY_NOT_ENTITLED`. If thread persistence is gated by the same
entitlement, that would explain it.

**Impact.** `thread.resume()` can never be reached, so
`/teams/interactive`'s documented post-and-resume flow is unusable. This is
agent-independent — `resume()` → `run()` → `conversationStore.getOrCreate()` →
`loadHistory()` regardless of which agent posted the card.

**Ask.** Enable thread persistence for project 2199, or have the channel path
create the thread on demand the way the HTTP run handler does.

### 1a. Consequence with LangGraph: permanent conversation deadlock

With a Deep Agent (`interrupt()` → `on_interrupt` → `thread.resume()`), finding 1
does not merely fail the click — it wedges the conversation permanently:

```
GET http://localhost:8123/threads/8c510f75-…/state
next:     ["tools"]
tasks:    1  interrupts: [{"value":{"summary":"Request approval to roll back … INC-421."}}]
messages: 19
```

`resume()` never lands, so the interrupt never clears. Every later message
re-enters the suspended thread, LangGraph re-surfaces the same pending
interrupt, and the bot answers *every* message — including "hi" — with the same
stale approval card. Recovery requires resuming or deleting the graph thread
out of band.

---

## 2. Teams interaction deliveries omit `messageRef`, so cards cannot be updated

`/teams/interactive` documents updating the card on click:

```tsx
if (message.ref.id) {
  await thread.update(message.ref, <Message><Header>Approved</Header>…</Message>);
}
```

`message.ref.id` is always `""` on managed Teams. The delivery contract marks
`messageRef` optional (`delivery-transport.js:944`), Intelligence does not send
it, and core substitutes a placeholder (`create-channel.js:459`):

```js
ref: evt.messageRef ?? { id: "" },
```

So the documented guard always skips, and the card can never flip to
Approved/Rejected.

**No workaround exists.** A ref captured from the original `thread.post()`
cannot be reused later: `messageRef()` embeds `claimedDelivery`, a live
per-delivery object (`delivery-adapter.js:1100`), and `update()` dispatches on
`ref.claimedDelivery` (`delivery-adapter.js:357`). It is not JSON-serializable,
so it cannot go in thread state, and it belongs to a delivery that has closed.

**Ask.** Populate `messageRef` on Teams interaction deliveries. The inbound
card-action activity carries `replyToId`; what is missing is an
Intelligence-minted provider reference, which only the server can produce.

---

## 3. Every card renders twice on managed Teams

Each structured message appears twice in the client: once as markdown text, once
as the Adaptive Card. Button labels appear in the text copy as backtick code
spans, so they look like buttons but are inert.

`teamsMessageEffect` (`delivery-adapter.js:1028`) sets `text` unconditionally
*and* attaches the card:

```js
const text = renderTeamsMarkdown(portable);          // always
const renderedCards = [
  ...(!isPlainText(portable) && portable.length > 0 ? [renderAdaptiveCard(portable)] : []),
  ...nativeCards,
];
return { kind: "teams.message.create", text, ...cards };
```

The direct Teams adapter gets this right (`@copilotkit/channels-teams/dist/adapter.js:311`):

```js
return isPlainText(ir) ? { text: renderTeamsMarkdown(ir) } : { card: renderAdaptiveCard(ir) };
```

Verified against one `<Message><Header>…</Header><Section>…</Section></Message>`:

```
activity.text: "**INC-421 · investigating**\n\nCheckout latency is above the SLO."
card body:     TextBlock "INC-421 · investigating" + TextBlock "Checkout latency…"
```

**Ask.** Apply the direct adapter's either/or on the managed path, or have the
card suppress the text fallback.

---

## 4. `on_interrupt` payload is a JSON string, not the documented object

`/teams/interactive` implies an object:

```tsx
channel.onInterrupt<{ summary: string }>("on_interrupt", async ({ payload, thread }) => {
  await thread.post(<ApprovalCard summary={payload.summary} />);
});
```

The value arrives serialized:

```
CUSTOM name:  "on_interrupt"
CUSTOM value: "{\"summary\":\"Requesting approval to roll back incident INC-421.\"}"
```

`payload` is passed through verbatim (`channels-core/dist/thread.js:484`,
`payload: interrupt.value`), so `payload.summary` is `undefined` and the
documented snippet renders `<Section>{undefined}</Section>` — an Adaptive Card
`TextBlock` with `"text": ""`, which is not valid card content.

**Ask.** Either parse the value before dispatch, or correct the docs to show a
string payload.

---

## 5. `tenant.id` is `"unknown"` on managed Teams, though Intelligence knows it

`/teams/identity-and-memory` instructs keying identity on the tenant:

> For Microsoft Teams, `tenant.id` identifies the Microsoft tenant … include the
> tenant in the external-identity key.

```typescript
identifyUser: async ({ provider, tenant, actor }) =>
  linkedAccounts.get(`${provider}:${tenant.id}:${actor.id}`) ?? null,
```

What `identifyUser` actually receives:

```
{ provider: 'teams', tenant: { id: 'unknown' }, installation: { id: 'unknown' },
  conversation: { id: '8c510f75-…', kind: 'thread' }, trigger: 'message',
  actorKind: 'human', hasLookupProfile: false, rawKeys: ['kind'] }
```

Following the docs therefore keys every account link on the literal string
`unknown`, silently losing cross-tenant isolation — and it breaks the day the
field is populated.

Intelligence clearly *has* the tenant: it appears in the `userId` it builds for
its own API calls (finding 1) — `teams:4a9a274f-28cb-48eb-9c3d-f9614979e2dd:29:…`.
It just is not forwarded in the identity context.

**Ask.** Forward the real tenant on the identity context, or amend the Teams
docs to say it is unavailable and keys must be actor-scoped.

---

## Reproduction

Harness: seven `/teams/*` doc pages wired into one Channel, one module per page.

```bash
cd my-teams-channel && npm install && npm start
```

Then, in Teams: `request approval to roll back INC-421` → card posts (twice,
finding 3) → click **Approve** → card does not update (finding 2) and the
delivery fails with `THREAD_NOT_FOUND` (finding 1).

Failing delivery ids: `dlv_01a02450-9f5c-7d4a-a22c-316a3858d9e7`,
`dlv_01a02451-29bc-73dd-a7ac-5f2c28fd9c5e`,
`dlv_01a02453-67ce-7175-9609-9f659ee41835`,
`dlv_01a02459-fb4a-7355-8df0-cc1bccd31d90`.
Last fully successful deliveries: `dlv_01a02446-995e-763c-9fa9-9fee5de4a715`,
`dlv_01a02446-e58d-7942-8c5b-3c612dd8df3e` (both plain text turns).
