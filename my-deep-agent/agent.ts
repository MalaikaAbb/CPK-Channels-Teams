// Deep Agent backing the Microsoft Teams Channel.
//
// Sources:
//   https://docs.copilotkit.ai/deepagents/quickstart
//   https://docs.copilotkit.ai/deepagents/human-in-the-loop/interrupt-flow
//   https://docs.copilotkit.ai/teams/deepagents/connect
//
// The point of this agent is `request_approval`. LangGraph's `interrupt()`
// suspends the graph; the runtime's LangGraph adapter surfaces that as the
// `on_interrupt` event (LangGraphEventTypes.OnInterrupt === "on_interrupt"),
// which is exactly what `channel.onInterrupt("on_interrupt", ...)` listens for.
// BuiltInAgent could never emit it, which is why approvals could not resume and
// the Channel needed a `request_approval` CHANNEL tool as a stand-in.
//
// With this graph running, that stand-in is unregistered (see the Channel's
// channel.tsx) and the documented managed flow is the live one:
//
//   agent calls request_approval
//     -> interrupt() suspends the graph
//     -> adapter emits on_interrupt
//     -> channel.onInterrupt posts <ApprovalCard summary={...} /> and returns
//     -> Intelligence acks the original turn
//     -> a later Adaptive Card button click calls thread.resume(value)
//     -> LangGraph resumes inside interrupt() with that value
import { createDeepAgent } from "deepagents";
import { copilotkitMiddleware } from "@copilotkit/sdk-js/langgraph";
import { interrupt } from "@langchain/langgraph";
import { AIMessage, createMiddleware, tool, type BaseMessage } from "langchain";
import { z } from "zod";

// A Channel that runs a frontend tool (get_incident, ...) sends back its own
// copy of the assistant tool-call message (id `<toolCallId>-assistant`) ahead
// of the result, because after the MESSAGES_SNAPSHOT merge its last local
// message is one of the middleware's "App Context" system messages rather than
// the tool-call message. The ids differ, so LangGraph keeps both, and OpenAI
// rejects the transcript with "An assistant message with 'tool_calls' must be
// followed by tool messages". Drop the superseded copy before every model call.
export function dropSupersededToolCallMessages(
  messages: BaseMessage[],
): BaseMessage[] {
  const lastIssuedAt = new Map<string, number>();
  messages.forEach((m, i) => {
    if (!AIMessage.isInstance(m)) return;
    for (const tc of m.tool_calls ?? []) if (tc.id) lastIssuedAt.set(tc.id, i);
  });
  return messages.filter(
    (m, i) =>
      !(
        AIMessage.isInstance(m) &&
        m.tool_calls?.length &&
        m.tool_calls.every((tc) => tc.id && lastIssuedAt.get(tc.id)! > i)
      ),
  );
}

const dedupeToolCallMessages = createMiddleware({
  name: "DedupeToolCallMessages",
  wrapModelCall: (request, handler) => {
    const messages = dropSupersededToolCallMessages(request.messages);
    return handler(
      messages.length === request.messages.length
        ? request
        : { ...request, messages },
    );
  },
});

const requestApproval = tool(
  async ({ summary }: { summary: string }) => {
    // Suspends the graph. The Channel posts <ApprovalCard summary={...} /> from
    // its onInterrupt handler and returns, acking the turn. A later button
    // click calls thread.resume(value), and LangGraph resumes HERE with that
    // value -- the Button's `value={{ approved: true | false }}`.
    const decision = (await interrupt({ summary })) as
      | { approved?: boolean }
      | undefined;

    return decision?.approved
      ? `The human APPROVED: ${summary}`
      : `The human REJECTED: ${summary}`;
  },
  {
    name: "request_approval",
    description:
      "Ask a human to approve or reject an action. Call this immediately " +
      "whenever the user asks for approval. Do NOT ask the user to rephrase " +
      "or supply a summary -- write the summary yourself from what they said.",
    schema: z.object({
      summary: z
        .string()
        .describe("One sentence describing what is being approved."),
    }),
  },
);

export const agent = createDeepAgent({
  model: "openai:gpt-4o",
  tools: [requestApproval],
  middleware: [dedupeToolCallMessages, copilotkitMiddleware],
  // The Channel forwards its own tools (get_incident, show_incident, and the
  // per-turn list_my_approvals) over AG-UI alongside this graph's tools, so the
  // prompt refers to them without declaring them here.
  systemPrompt:
    "You are an incident support assistant operating in Microsoft Teams. Use " +
    "the channel tools you are given to read and display incidents. When a " +
    "human must approve an action, call request_approval and wait for the " +
    "result.",
});
