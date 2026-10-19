// Source: https://docs.copilotkit.ai/teams/interactive
import { defineChannelTool } from "@copilotkit/channels";
import { Teams } from "@copilotkit/channels/teams";
import { z } from "zod";

// ---------------------------------------------------------------------------
// "Post a Native Action"
//
// Component props must remain JSON-serializable. Only treat interaction messages
// as updateable when `message.ref.id` is non-empty. The card update here is
// best-effort: a missing ref or a failed update must not prevent
// `thread.resume(value)` from continuing the approval.
//
// Register in createChannel({ components: [ApprovalCard] }) so the action
// registry can rebuild the component when a later click arrives.
//
// ---------------------------------------------------------------------------
// DEVIATION FROM THE DOCS: built from Teams-NATIVE JSX (`Teams.*`), not the
// portable `<Message>/<Header>/<Section>/<Actions>/<Button>` set the page shows.
//
// WHY: on the managed path every portable message is delivered TWICE -- once as
// markdown text and once as the Adaptive Card. `teamsMessageEffect`
// (@copilotkit/channels-intelligence/dist/delivery-adapter.js:1121) sets `text`
// unconditionally AND attaches the card:
//
//   const text = renderTeamsMarkdown(portable);          // always
//   return { kind: "teams.message.create", text, ...cards };
//
// The DIRECT Teams adapter picks one or the other (channels-teams
// adapter.js:315), so this is managed-path-only. In Teams the text copy renders
// the buttons as inert backtick code spans directly above the real card.
//
// The fix: `text` is built from `portable`, and `portable` excludes native
// nodes --
//
//   const nativeJsx = ir.filter(isNativeNode);
//   const portable  = ir.filter((n) => n.type !== "raw" && !isNativeNode(n));
//
// so a card made entirely of `Teams.*` leaves `portable` empty,
// `renderTeamsMarkdown([])` returns "", and only the card is delivered.
//
// Routing is unaffected. `renderTeamsNativeCard` emits the SAME action envelope
// the portable `<Button>` does -- `data.ckActionId` + `data.value`
// (native-codec.js `serializeTeamsNode`, vs adaptive-card.js `renderButton`) --
// so `onClick`, the registry rebuild, and `thread.resume` all behave identically.
//
// COST: this card is now Teams-only. The portable version would have rendered on
// Slack too. Revert to `<Message>` if this channel ever needs another provider,
// or once the managed path adopts the direct adapter's either/or.
// ---------------------------------------------------------------------------
export function ApprovalCard({ summary }: { summary: string }) {
  return (
    <Teams.AdaptiveCard>
      <Teams.TextBlock
        text="Approval required"
        weight="Bolder"
        size="Medium"
        wrap
      />
      <Teams.TextBlock text={summary} wrap />
      <Teams.Action.Submit
        title="Approve"
        style="positive"
        value={{ approved: true }}
        onClick={async ({ thread, message, action }) => {
          const value = action.value;
          if (value === undefined) {
            await thread.post(
              "The approval value was missing. Please try again.",
            );
            return;
          }

          if (message.ref.id) {
            try {
              await thread.update(
                message.ref,
                <ApprovalResolvedCard outcome="Approved" summary={summary} />,
              );
            } catch {
              // Updating the card is best-effort; always resume the agent.
            }
          }
          await thread.resume(value);
        }}
      />
      <Teams.Action.Submit
        title="Reject"
        style="destructive"
        value={{ approved: false }}
        onClick={async ({ thread, message, action }) => {
          const value = action.value;
          if (value === undefined) {
            await thread.post(
              "The approval value was missing. Please try again.",
            );
            return;
          }

          if (message.ref.id) {
            try {
              await thread.update(
                message.ref,
                <ApprovalResolvedCard outcome="Rejected" summary={summary} />,
              );
            } catch {
              // Updating the card is best-effort; always resume the agent.
            }
          }
          await thread.resume(value);
        }}
      />
    </Teams.AdaptiveCard>
  );
}

// The post-click state. Also native, for the same reason: a portable
// replacement would reintroduce the doubled text on the `replace` effect, which
// takes the identical `text` + `cards` path.
//
// Carries no actions, so it needs no registration in `components`.
function ApprovalResolvedCard({
  outcome,
  summary,
}: {
  outcome: "Approved" | "Rejected";
  summary: string;
}) {
  return (
    <Teams.AdaptiveCard>
      <Teams.TextBlock text={outcome} weight="Bolder" size="Medium" wrap />
      <Teams.TextBlock text={summary} wrap />
    </Teams.AdaptiveCard>
  );
}

// ---------------------------------------------------------------------------
// NOT FROM THE DOCS -- required to make the documented handler correct here.
//
// `channel.onInterrupt` receives the agent's custom-event value VERBATIM: the
// SDK passes `payload: interrupt.value` straight through (channels-core
// thread.js). The LangGraph adapter serializes the `interrupt()` argument to a
// JSON **string**, so the payload arrives as
//
//   '{"summary":"Roll back INC-421."}'      <- a string
//
// not as `{ summary: "..." }`. Reading `payload.summary` off a string yields
// `undefined`, which renders <Section>{undefined}</Section> as an Adaptive Card
// TextBlock with `"text": ""`. An empty TextBlock is not valid card content and
// the provider call can fail or hang on it.
//
// Parse defensively: a direct adapter may well hand over the object, so accept
// both, and never return an empty string.
const FALLBACK_SUMMARY = "An action needs your approval.";

export function readInterruptSummary(payload: unknown): string {
  let value: unknown = payload;

  if (typeof value === "string") {
    const raw = value;
    try {
      value = JSON.parse(raw);
    } catch {
      // A bare, non-JSON string is itself the summary.
      const text = raw.trim();
      return text === "" ? FALLBACK_SUMMARY : text;
    }
  }

  const summary = (value as { summary?: unknown } | null | undefined)?.summary;
  return typeof summary === "string" && summary.trim() !== ""
    ? summary
    : FALLBACK_SUMMARY;
}

// ---------------------------------------------------------------------------
// "Use Post-and-Resume for Managed Approvals"
//
//   1. The agent emits an `on_interrupt` event
//   2. `channel.onInterrupt` posts the registered component and returns
//   3. Intelligence acknowledges the original turn
//   4. A later click updates the card when possible and calls
//      `thread.resume(value)`
//   5. The SDK re-enters the agent with the approval result
//
// Managed deliveries CANNOT wait inside `thread.awaitChoice()`, because clicks
// arrive as separate claimed deliveries.
//
// The `channel.onInterrupt("on_interrupt", ...)` registration lives in
// channel.tsx, exactly as the page shows it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ACTIVE. Registered in channel.tsx because the harness runs BuiltInAgent, which
// never emits `on_interrupt`, so the documented path above cannot fire.
//
// NOT FROM THE DOCS: a way to reach the approval flow without an
// interrupt-capable agent backend. It substitutes for steps 1-2 of the managed
// flow -- it posts the SAME registered ApprovalCard from inside the run.
//
// UNREGISTER it when switching back to the Deep Agent (../my-deep-agent), whose
// graph owns a `request_approval` of its own.
//
// It works because `thread.resume()` needs a *continuation*, and a continuation
// is bound to any component posted while one is active:
//
//   runAgent()  -> sets `this.activeContinuation` for the whole run
//   makeToolCtx -> gives the tool `thread: this` (the SAME Thread)
//   thread.post -> bindRenderable(ui, conversationKey, this.activeContinuation)
//
// So a tool posting the card during the run binds resume capability to its
// buttons, exactly as an `onInterrupt` post would.
//
// NOTE: the click still cannot COMPLETE the approval on this project --
// `thread.resume()` fails with THREAD_NOT_FOUND regardless of which agent posted
// the card. What this buys over the graph is that the failure is inert: no
// LangGraph interrupt is left pending, so the conversation keeps working.
// ---------------------------------------------------------------------------
export const requestApproval = defineChannelTool({
  name: "request_approval",
  // DEVIATION FROM THE HARNESS'S FIRST DRAFT: the original description opened
  // with "Call this immediately whenever the user asks for approval", which the
  // model generalized -- once the Teams transcript held a few approval cards it
  // called this on greetings and capability questions too. The trigger is now
  // stated as a precondition, with the negative cases spelled out. The system
  // prompt in agent.ts reinforces it.
  description:
    "Post an approval card asking a human to approve or reject a specific " +
    "action. PRECONDITION: the user's CURRENT message must explicitly request " +
    "approval, or request an action that needs a human decision. Do NOT call " +
    "this for greetings, small talk, or questions about your capabilities, and " +
    "do NOT call it merely because earlier messages in this conversation " +
    "contain approval cards. When the precondition holds, write the summary " +
    "yourself from what the user already said -- never ask them to rephrase, " +
    "clarify, or supply it.",
  parameters: z.object({
    summary: z
      .string()
      .describe(
        "One sentence you compose describing what is being approved, e.g. " +
          '"Roll back INC-421 to restore checkout latency." Never ask the ' +
          "user to provide this.",
      ),
  }),
  async handler({ summary }, { thread }) {
    await thread.post(<ApprovalCard summary={summary} />);
    return (
      "Approval card posted. The decision is pending -- do not assume an " +
      "outcome or state whether it was approved."
    );
  },
});

// ---------------------------------------------------------------------------
// "Capability Differences"
//
// Text and sections are the portable baseline. Interactive features depend on
// provider configuration:
//   - Teams delivers `Action.Submit` buttons in Adaptive Cards as message
//     activities
//   - Incoming reactions can be handled when Intelligence delivers them
//   - Modal callbacks are DIRECT-ADAPTER capabilities (not managed Teams)
//   - Ephemeral messages, conversation titles, and suggested prompts may return
//     `{ ok: false }`
//
// Because those last ones return a result rather than throwing, check `ok`
// instead of assuming delivery -- see features/commands-and-reactions.ts for the
// same pattern applied to `thread.react()`.
// ---------------------------------------------------------------------------
