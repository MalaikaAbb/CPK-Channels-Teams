// Source: https://docs.copilotkit.ai/teams/threads-and-state
import { z } from "zod";
import type { StatefulThread } from "@copilotkit/channels";

// ---------------------------------------------------------------------------
// "Conversation identity"
//
// Every delivered Teams conversation becomes a Channels SDK `Thread` -- the
// reply and workflow handle passed to `onMessage`, tools, interactions, and
// interrupt callbacks.
//
// `thread.conversationKey` is the OPAQUE, stable key Intelligence supplies for
// the native conversation. Do not parse it or infer tenant, team, channel, or
// thread identifiers from its value. The SDK passes that same value to the
// `agent(threadId)` factory in agent.ts.
//
// Managed delivery admission keeps one canonical conversation exclusive while
// unrelated conversations run in parallel. The SDK `store.concurrency` setting
// governs other adapter paths and shared workflow state; it does NOT raise the
// managed same-Thread delivery limit.
//
// The native provider is available on both `message.platform` and
// `thread.platform`. Managed turns report "slack" or "teams".
//
// A Channels `Thread` is NOT Rich Threads (CopilotKit's application UI for
// browsing and restoring agent conversations). Same idea of a stable thread id;
// different APIs and surfaces.
//
// A Thread can contain several provider actors and has no personal owner -- see
// features/identity-and-memory.tsx before attaching application-user data or
// personal Memory to a turn.
// ---------------------------------------------------------------------------

// "Persist workflow state"
//
// `thread.state()` and `thread.setState()` hold JSON-serializable state keyed by
// `conversationKey`. A Standard Schema makes reads typed and validates writes.
export const workflowState = z.object({
  incidentId: z.string(),
  stage: z.enum(["triage", "awaiting-approval", "resolved"]),
});

export type WorkflowState = z.infer<typeof workflowState>;

// The page's `onMessage` body, extracted so channel.tsx keeps ONE message
// handler. `setState` REPLACES the stored value; it does not merge a partial
// patch -- which is why `incidentId` is read back and re-supplied here.
export async function advanceTriage(thread: StatefulThread<WorkflowState>) {
  const current = await thread.state();
  await thread.setState({
    incidentId: current?.incidentId ?? "INC-421",
    stage: "triage",
  });
}

// HARNESS GLUE (not from the docs): `advanceTriage` writes state that nothing
// ever reads back, so there is no way to observe it from Teams. These two make
// `thread.state()` / `thread.setState()` visible.
export async function showState(thread: StatefulThread<WorkflowState>) {
  const current = await thread.state();
  await thread.post(
    current
      ? `Thread state: \`${JSON.stringify(current)}\``
      : "No state stored for this conversation yet.",
  );
}

// An invalid `stage` is rejected by the Standard Schema at runtime, which is the
// point of configuring `store.state`.
export async function setStage(
  thread: StatefulThread<WorkflowState>,
  stage: string,
) {
  const current = await thread.state();
  try {
    await thread.setState({
      incidentId: current?.incidentId ?? "INC-421",
      stage: stage as WorkflowState["stage"],
    });
    await thread.post(`Stage set to \`${stage}\`.`);
  } catch (error) {
    await thread.post(
      `Rejected by the state schema: ${(error as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// "Choose the persistence boundary deliberately"
//
// The managed realtime path restores platform conversation history, but it does
// NOT automatically wire a durable SDK `StateStore`. Without `store.adapter`,
// the default MemoryStore keeps these only in the current process:
//   - thread.state()
//   - registered interactive-action snapshots
//   - SDK locks, deduplication windows, and queues
//
// DEVIATION FROM THE DOCS: the page's snippet passes
// `adapter: durableStateStore` imported from "./state-store.js", but never
// defines it -- it is a placeholder for your implementation, like `incidents`
// and `approvals` in services/fixtures.ts. This harness leaves `store.adapter`
// UNSET and runs on the default MemoryStore, so nothing here pretends to be
// durable.
//
// Consequences you will actually observe:
//   - restart the process and `!state` reports nothing
//   - an approval card posted before a restart degrades to "action expired"
//   - a FeedbackCard's per-message `onReaction` stops firing after a restart
//
// Before shipping restart-safe approvals, supply a durable application
// implementation of the StateStore contract (key/value, list, lock, dedup, and
// queue operations; values must round-trip through JSON):
//   https://docs.copilotkit.ai/reference/channels/classes/Channel#statestore-contract
//
// "Do not infer durability from Online status." Online confirms a healthy
// managed connection that can receive delivery invitations. Send a real Teams
// message to test delivery, and test a RESTART while an approval card is pending
// before shipping a durable workflow.
//
// Operational checklist (from the page):
//   - one fresh agent per conversationKey                    -> agent.ts
//   - pass the current inbound message to runAgent           -> channel.tsx
//   - branch on message.platform for the current turn        -> channel.tsx
//   - store only JSON-serializable workflow data             -> workflowState
//   - replace, do not patch, values passed to setState       -> above
//   - configure a durable StateStore before promising
//     restart-safe approvals                                 -> NOT DONE HERE
//   - stop the listener on SIGINT and SIGTERM so Intelligence
//     can release the runtime cleanly                        -> index.tsx
// ---------------------------------------------------------------------------
