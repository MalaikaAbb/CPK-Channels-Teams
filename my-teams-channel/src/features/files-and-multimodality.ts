// Source: https://docs.copilotkit.ai/teams/files-and-multimodality
import type { IncomingMessage, Thread } from "@copilotkit/channels";

// ---------------------------------------------------------------------------
// Content-part mapping (from the page). Managed ingress converts each
// provider file into an `AgentContentPart`:
//
//   Image MIME type   { type: "image",    source: { type: "data", value, mimeType } }
//   Audio MIME type   { type: "audio",    source: ... }
//   Video MIME type   { type: "video",    source: ... }
//   PDF               { type: "document", source: ... }
//   text/*            UTF-8 { type: "text", text }
//   Other binary      a text note naming the attachment and MIME type
// ---------------------------------------------------------------------------

// "Pass attachments to the agent"
//
// Managed conversation history does not contain the current inbound turn.
// `runAgent()` automatically chooses the inbound text or attachment parts when
// `prompt` is omitted. Build a combined prompt when the same turn can carry both
// `message.text` and `message.contentParts`.
//
// If you pass only `message.text`, the model will NOT receive hydrated binary
// attachments. If `contentParts` exists, do not append it to managed history
// yourself; `runAgent` adds the explicit prompt for this turn.
export function buildPrompt(message: IncomingMessage) {
  return message.contentParts?.length
    ? [
        ...(message.text
          ? [{ type: "text" as const, text: message.text }]
          : []),
        ...message.contentParts,
      ]
    : message.text;
}

// "Post a file"
//
// `thread.postFile()` takes bytes and RETURNS a result instead of throwing for
// an unsupported provider capability -- so check `ok`. Intelligence currently
// accepts individual inbound and outbound Channel files up to 25 MiB; provider
// limits can be lower.
export async function postIncidentReport(
  thread: Pick<Thread, "post" | "postFile">,
) {
  const csv = new TextEncoder().encode(
    ["id,status", "INC-421,investigating"].join("\n"),
  );

  const result = await thread.postFile({
    bytes: csv,
    filename: "incident-report.csv",
    title: "Incident report",
    altText: "CSV export of the incident report",
  });

  if (!result.ok) {
    await thread.post(`The report could not be attached: ${result.error}`);
  }
}

// ---------------------------------------------------------------------------
// TEAMS-SPECIFIC CONSIDERATIONS (from the page)
//
// - Personal (1:1) chats support downloadable attachments directly.
// - Team CHANNELS use SharePoint references and inline content through
//   Microsoft Graph, so a channel upload and a DM upload do not arrive by the
//   same route. Test both.
// - The bot requires the `ChannelMessage.Read.Group` resource-specific consent,
//   which TEAM OWNERS grant during installation. Installing into a team without
//   that consent yields channel messages the bot cannot read attachments from.
// - The optional `Files.Read.All` permission enables SharePoint file retrieval
//   but is NOT required for the connection to function -- so a missing
//   `Files.Read.All` shows up as absent attachments, not as a failed Channel.
//
// SECURITY GUIDANCE (from the page). Treat every attachment as untrusted:
//   - validate MIME types AND file signatures (never trust the declared type)
//   - limit decompression (zip bombs)
//   - never execute macros
//   - authenticate the user before consequential writes
//   - do not log sensitive file content
//
// This harness does none of that -- it only forwards parts to the model. Add
// validation here before accepting real uploads.
// ---------------------------------------------------------------------------
