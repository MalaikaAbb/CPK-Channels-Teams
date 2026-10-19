import { createChannel, defineChannelTool } from "@copilotkit/channels";
import { z } from "zod";

import { makeAgent } from "./agent.js";
import { required } from "./env.js";
import { withErrorLogging } from "./diagnostics.js";
import { approvals, incidents } from "./services/fixtures.js";

// /teams/tools
import {
  channelContext,
  getIncident,
  showIncident,
} from "./features/tools.js";
// /teams/identity-and-memory
import {
  ApprovalButtonCard,
  identifyUser,
  memoryGrant,
  projectMemoryGrant,
} from "./features/identity-and-memory.js";
// /teams/rich-messages
import {
  IncidentDigest,
  TriageForm,
  postAndUpdateIncidentCard,
} from "./features/rich-messages.js";
// /teams/interactive
import {
  ApprovalCard,
  readInterruptSummary,
} from "./features/interactive.js";
// /teams/commands-and-reactions
import {
  FeedbackCard,
  registerReactionHandlers,
  toggleOwnReaction,
} from "./features/commands-and-reactions.js";
// /teams/files-and-multimodality
import {
  buildPrompt,
  postIncidentReport,
} from "./features/files-and-multimodality.js";
// /teams/threads-and-state
import {
  advanceTriage,
  setStage,
  showState,
  workflowState,
} from "./features/threads-and-state.js";

export const channel = createChannel({
  name: required("CHANNEL_CODE"),
  // /teams/identity-and-memory -- replaces the quickstart's "platform" policy.
  identifyUser,
  agent: makeAgent,
  // /teams/tools
  // `requestApproval` is intentionally ABSENT: the active backend is the Deep
  // Agent (agent.ts), whose graph owns a `request_approval` of its own, and two
  // tools of the same name collide. The channel-level stand-in is still
  // exported from features/interactive.tsx -- re-add it here if you switch back
  // to BuiltInAgent, which never emits `on_interrupt`.
  tools: [getIncident, showIncident],
  context: channelContext,
  // /teams/interactive + /teams/commands-and-reactions + /teams/rich-messages
  // Registration lets the action registry rebuild a named component when a
  // later click or reaction arrives. Pure display components (IncidentCard,
  // IncidentDigest) carry no callbacks and need no registration.
  components: [ApprovalCard, FeedbackCard, ApprovalButtonCard, TriageForm],
  // /teams/threads-and-state -- `adapter` is intentionally unset, so the default
  // in-process MemoryStore is used. See features/threads-and-state.ts.
  store: {
    state: workflowState,
  },
});

// /teams/threads-and-state -- "Welcome a new installation or conversation".
// A lifecycle event, not a synthetic user message: it does not run `onMessage`
// or add a made-up user turn to the conversation. `user` is the nullable
// application user selected by `identifyUser` for that event.
channel.onWelcome(async ({ thread, user }) => {
  await thread.post(
    user ? `Welcome, ${user.name}.` : "Welcome. How can I help?",
  );
});

// /teams/commands-and-reactions
registerReactionHandlers(channel);

// /teams/interactive -- post-and-resume. The handler posts the registered
// component and returns; a later click calls `thread.resume(value)`.
//
// This is now the LIVE path: the Deep Agent's request_approval calls
// interrupt(), the LangGraph adapter emits `on_interrupt`, and this handler
// posts the card. See agent.ts for the deadlock risk when the click fails.
// `payload` is typed `unknown` on purpose: the LangGraph adapter delivers the
// interrupt value as a JSON STRING, not the object the docs' snippet implies.
// readInterruptSummary handles both and never yields an empty summary.
channel.onInterrupt<unknown>("on_interrupt", async ({ payload, thread }) => {
  await thread.post(<ApprovalCard summary={readInterruptSummary(payload)} />);
});

// ---------------------------------------------------------------------------
// One `onMessage` handler merges every page's message-path code. The SDK runs
// ALL registered `onMessage` handlers, so a second registration would run the
// agent twice on the same turn.
//
// `onMention` is deliberately not registered: a mention falls back to
// `onMessage` when it is absent, so channel @mentions and 1:1 chats share this
// single path. See features/commands-and-reactions.tsx.
// ---------------------------------------------------------------------------
channel.onMessage(
  withErrorLogging("onMessage", async ({ thread, message }) => {
    // -----------------------------------------------------------------------
    // HARNESS GLUE (not from the docs).
    //
    // Managed Teams does not interpret `/name` prefixes -- leading-slash text
    // arrives as ordinary message content (/teams/commands-and-reactions). These
    // prefixes give each doc page a way to be exercised on demand. `!card` and
    // `/card` are equivalent; the `!` form exists for parity with the Slack
    // harness, where Slack can reject an unregistered slash command client-side.
    // -----------------------------------------------------------------------
    const raw = message.text?.trim() ?? "";
    const text = raw.startsWith("!") ? `/${raw.slice(1)}` : raw;

    if (text.startsWith("/card")) {
      // /teams/rich-messages -- post, then update in place.
      await postAndUpdateIncidentCard(thread, {
        id: "INC-421",
        summary: "Checkout latency is above the SLO.",
        owner: "Payments",
      });
      return;
    }
    if (text.startsWith("/digest")) {
      // /teams/rich-messages -- Adaptive Card 1.5 Table + Teams chart extension.
      await thread.post(<IncidentDigest incidents={await incidents.list()} />);
      return;
    }
    if (text.startsWith("/triage")) {
      // /teams/rich-messages -- Adaptive Card inputs submitted by a Button's
      // Action.Submit, which is the only Teams path that fires a handler.
      await thread.post(<TriageForm incidentId="INC-421" />);
      return;
    }
    if (text.startsWith("/report")) {
      // /teams/files-and-multimodality
      await postIncidentReport(thread);
      return;
    }
    if (text.startsWith("/feedback")) {
      // /teams/commands-and-reactions
      await thread.post(<FeedbackCard answerId="ans_1" />);
      return;
    }
    if (text.startsWith("/subject")) {
      // /teams/identity-and-memory -- the `subject: "initiator"` resume demo.
      // Clicking it needs an active continuation, so expect
      // ChannelContinuationRequiredError when posted standalone.
      await thread.post(
        <ApprovalButtonCard summary="Roll back INC-421 to restore checkout latency." />,
      );
      return;
    }
    if (text.startsWith("/state")) {
      // /teams/threads-and-state
      const stage = text.slice("/state".length).trim();
      if (stage) await setStage(thread, stage);
      else await showState(thread);
      return;
    }
    if (text.startsWith("/react")) {
      // /teams/commands-and-reactions -- add and remove the bot's own reaction
      // using the delivery-scoped reference from the current message.
      //
      // Behind a trigger on purpose: the bot's own reaction comes straight back
      // in as a reaction delivery, firing the handlers registered by
      // `registerReactionHandlers`. Running it on every message made the bot
      // reply to itself on every turn.
      await toggleOwnReaction(thread, message.ref);
      return;
    }

    // /teams/threads-and-state
    await advanceTriage(thread);

    // /teams/tools -- a tool scoped to the current person. Its closure captures
    // the trusted inbound identity, so it is only defined when the actor
    // resolved to an application user. Provider actor IDs are external
    // identifiers; personal product data keys on the resolved application user.
    const perRunTools = [];
    if (message.user) {
      const user = message.user;
      perRunTools.push(
        defineChannelTool({
          name: "list_my_approvals",
          description:
            "List approval records already assigned to the requesting user in " +
            "the approvals directory. These are stored records, NOT approval " +
            "cards awaiting a click in this conversation -- a row here never " +
            "means a card is pending and never blocks request_approval.",
          parameters: z.object({}),
          async handler() {
            return approvals.forApplicationUser(user.id);
          },
        }),
      );
    }

    await thread.runAgent({
      // /teams/files-and-multimodality -- combine text and attachments when the
      // turn carries both.
      prompt: buildPrompt(message),
      tools: perRunTools,
      // /teams/tools -- per-turn provider and user context.
      context: [
        { description: "Originating platform", value: message.platform },
        {
          description: "Requesting user",
          value: message.user?.name ?? "Unidentified application user",
        },
      ],
      // /teams/identity-and-memory -- user Memory fails with
      // `channel_memory_user_required` unless this event resolved to an
      // application user, so unlinked actors get project-only Memory.
      memory: message.user ? memoryGrant : projectMemoryGrant,
    });
  }),
);
