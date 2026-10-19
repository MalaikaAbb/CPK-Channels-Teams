// Per-conversation agent factory.
//
// Source: https://docs.copilotkit.ai/teams/threads-and-state ("Conversation
// identity") -- `thread.conversationKey` is the opaque, stable key Intelligence
// supplies for the native conversation, and it is the value handed to this
// factory. Prefer a FACTORY so each turn gets an explicit new instance.
//
// ---------------------------------------------------------------------------
// ACTIVE BACKEND: the Deep Agent in ../my-deep-agent.
//
// START IT FIRST -- `cd ../my-deep-agent && npm run dev` (port 8123). This
// factory does not reach out until a turn arrives, so a missing graph fails at
// the first message, not at startup.
//
// This is the backend the docs assume. Its `request_approval` tool calls
// LangGraph's `interrupt()`, the runtime's LangGraph adapter surfaces that as
// the `on_interrupt` event, and `channel.onInterrupt("on_interrupt", ...)` in
// channel.tsx posts the ApprovalCard -- the documented post-and-resume flow on
// /teams/interactive, end to end.
//
// The channel-level `requestApproval` stand-in is UNREGISTERED in channel.tsx
// while this backend is live: the graph owns a `request_approval` of its own,
// and two tools of the same name collide.
//
// ---------------------------------------------------------------------------
// KNOWN RISK -- read before testing. This is why the harness previously ran
// BuiltInAgent instead.
//
// Approvals cannot COMPLETE on Intelligence project 2199, and under LangGraph
// that failure is not inert -- it wedges the conversation permanently:
//
//   1. The graph calls interrupt() -> the adapter emits `on_interrupt`
//      -> channel.onInterrupt posts the ApprovalCard. This part works.
//   2. Clicking a button calls `thread.resume(value)`.
//   3. resume() -> run() -> conversationStore.getOrCreate() -> loadHistory()
//      -> GET /api/threads/{canonicalThreadId}/messages -> 404 THREAD_NOT_FOUND.
//
// Interaction deliveries take that path because only `input.kind === "text"`
// reads history from the Teams transcript; everything else falls through to the
// Intelligence threads API (channels-intelligence delivery-adapter.js:53).
//
// Because resume never lands, the interrupt never clears, and LangGraph keeps
// the thread suspended at `next: ["tools"]`. Every LATER message re-enters the
// same suspended thread and replays the same interrupt -- so the bot answers
// every message, including "hi", with the same stale approval card. ONE failed
// approval permanently wedges the conversation.
//
// Recovery is out of band: resume or delete the graph thread directly against
// the LangGraph server on :8123.
//
// PRECONDITION for this to work: GET /api/threads?userId=<appUserId> must
// return a thread for the conversation. Last checked it returned
// `{"threads":[],...}` -- while that holds, the deadlock above is guaranteed.
//
// To go back to the inert-failure setup:
//   1. restore the BuiltInAgent factory (see git history / BUG_REPORT finding 1),
//   2. re-add `requestApproval` to `tools` in channel.tsx.
// ---------------------------------------------------------------------------
import { LangGraphAgent } from "@copilotkit/runtime/langgraph";

// No `prompt` here: unlike BuiltInAgent, the graph owns its own system prompt
// (see ../my-deep-agent/agent.ts `systemPrompt`). Steering the model's
// request_approval behaviour now means editing the GRAPH, not this file.
//
// `enableLegacyOnInterruptEvent` is left at its default of `true`, which is what
// keeps the CUSTOM(name="on_interrupt") event flowing to channel.onInterrupt.
// If a future @ag-ui/langgraph flips that default off, interrupts will surface
// only as RUN_FINISHED.outcome and onInterrupt will stop firing -- set it
// explicitly here at that point.
export function makeAgent(threadId: string) {
  const agent = new LangGraphAgent({
    deploymentUrl: process.env.LANGGRAPH_DEPLOYMENT_URL!,
    graphId: "sample_agent",
  });
  agent.threadId = threadId;
  return agent;
}
