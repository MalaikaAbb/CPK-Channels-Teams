// Source: https://docs.copilotkit.ai/teams/commands-and-reactions
//
// ---------------------------------------------------------------------------
// "Managed commands are not dispatched"
//
// The generated Slack manifest does not register slash commands, and MANAGED
// TEAMS DOES NOT INTERPRET `/name` PREFIXES. A message such as `/triage customer`
// therefore reaches `onMessage` or `onMention` as normal text.
//
// `defineChannelCommand`, `commands`, and `onCommand` remain available for
// direct adapters that emit native command events. They do not opt a managed
// Slack or Teams Channel into command routing -- which is why this harness
// dispatches its own text prefixes in channel.tsx instead of registering any.
//
// Teams is easier than Slack here: Slack validates a leading "/" against
// registered slash commands and can reject an unregistered one client-side.
// Teams just sends the text. The `!` aliases in channel.tsx are kept for parity
// with the Slack harness, not because Teams needs them.
// ---------------------------------------------------------------------------
//
// ---------------------------------------------------------------------------
// "Route mentions and ordinary messages"
//
// Register `onMessage` for ordinary provider messages. A bot mention selects
// `onMention` WHEN THAT HANDLER IS REGISTERED; otherwise the mention falls back
// to `onMessage`. Non-mention messages select `onMessage`, and one inbound
// message runs exactly one of those handler paths.
//
// Teams messages use the same selection after managed ingress normalizes the
// activity. This harness registers only `onMessage`, so channel @mentions and
// 1:1 chat messages both land in the same place -- one code path, no
// duplication. Register `onMention` too only if mentions should behave
// differently.
// ---------------------------------------------------------------------------
import { Message, Section } from "@copilotkit/channels/ui";
import type { Channel, Thread } from "@copilotkit/channels";
import type { MessageRef } from "@copilotkit/channels/ui";
import { audit, feedback } from "../services/fixtures.js";
import { withErrorLogging } from "../diagnostics.js";

// "Handle incoming reactions"
//
// Known Slack shortcodes and Teams reaction tokens are normalized to portable
// names. The portable outbound set is thumbs_up, thumbs_down, heart, fire, eyes,
// refresh, thinking, and tada.
//
// Teams `messageReaction` activities are normalized through the same handler:
// classic reactions such as Like and Heart, plus recognized modern emoji tokens,
// map to the SDK's portable names. `emoji` is the normalized value when the SDK
// recognizes it; `rawEmoji` retains the provider token for custom or unmapped
// emoji.
export function registerReactionHandlers(channel: Channel<any>) {
  channel.onReaction(
    "eyes",
    withErrorLogging("onReaction(eyes)", async ({ added, thread, user }) => {
      await thread.post(
        added
          ? `${user?.name ?? "Someone"} marked this response for follow-up.`
          : `${user?.name ?? "Someone"} removed the follow-up marker.`,
      );
    }),
  );

  // Omit the emoji argument to receive every added and removed reaction.
  //
  // DEVIATION FROM THE DOCS: the page shows this handler ending with
  // `await thread.post("Reaction recorded.")`. The two snippets read as
  // alternatives, but `reactionHandlers` is an array -- BOTH fire for the same
  // event, so an "eyes" reaction would produce two message effects in a single
  // managed delivery. This one only audits.
  //
  // "Output-free handlers are supported": the SDK finalizes and acknowledges a
  // managed turn even when its handler posts no message. Managed delivery is
  // still AT-LEAST-ONCE, so keep silent audit or database writes idempotent.
  channel.onReaction(
    withErrorLogging("onReaction(*)", async ({ emoji, rawEmoji, added }) => {
      audit.record({ emoji, rawEmoji, added });
    }),
  );
}

// "Attach a reaction handler to one message"
//
// Use `Message.onReaction` when only one posted component should react.
// Register FeedbackCard in createChannel({ components: [FeedbackCard] }).
//
// Surviving a process restart ALSO requires a durable `StateStore`, because the
// SDK must reload the component snapshot that owns this callback. This harness
// has none -- see features/threads-and-state.ts.
export function FeedbackCard({ answerId }: { answerId: string }) {
  return (
    <Message
      onReaction={async (emoji, reaction) => {
        if (reaction.added && emoji === "thumbs_up") {
          await feedback.record(answerId, reaction.user?.id);
          await reaction.thread.post("Thanks for the feedback.");
          return;
        }
        await reaction.thread.post("Reaction update received.");
      }}
    >
      <Section>React with 👍 if this solved the problem.</Section>
    </Message>
  );
}

// "Add or remove the bot's reaction with the delivery-scoped reference from the
// current message or transcript":
//
//   channel.onMessage(async ({ message, thread }) => {
//     await thread.react(message.ref, "eyes");
//     await thread.unreact(message.ref, "eyes");
//   });
//
// Wrapped below because of a Teams-specific caveat on the same page:
//
//   "Outbound reaction add/remove uses Microsoft's public-preview reaction API.
//    Managed setup verifies that API for the tenant and remains not ready when
//    the tenant cannot use it."
//
// `react`/`unreact` are capability-gated and resolve to `{ ok, error }` rather
// than throwing, so a tenant without the preview API fails SILENTLY unless the
// result is checked. This reports it instead.
//
// The portable set works on managed Slack and Teams. A provider-native string is
// allowed when your code branches on the native provider (`message.platform` in
// a message handler, `reaction.thread.platform` in `onReaction`); unsupported
// values fail explicitly.
export async function toggleOwnReaction(
  thread: Pick<Thread, "post" | "react" | "unreact">,
  ref: MessageRef,
) {
  const added = await thread.react(ref, "eyes");
  if (!added.ok) {
    await thread.post(
      `Could not add the reaction: ${added.error ?? "unsupported for this tenant"}`,
    );
    return;
  }

  const removed = await thread.unreact(ref, "eyes");
  if (!removed.ok) {
    await thread.post(
      `Added the reaction but could not remove it: ${removed.error ?? "unknown error"}`,
    );
    return;
  }

  await thread.post("Added and removed my own 👀 reaction.");
}
