// Source: https://docs.copilotkit.ai/teams/tools
import { defineChannelTool } from "@copilotkit/channels";
import { Header, Message, Section } from "@copilotkit/channels/ui";
import { z } from "zod";
import { incidents } from "../services/fixtures.js";

// "Add a channel-level tool"
// The parameter schema defines the tool's JSON schema and provides type safety
// for the handler.
//
// Return value guidelines (from the page):
//   - Return raw objects or arrays for data tools
//   - Return brief confirmations when handlers already posted UI
//   - Return or throw actual failure reasons for model recovery
//   - Avoid manually calling `JSON.stringify` on successful data
export const getIncident = defineChannelTool({
  name: "get_incident",
  description: "Read the current status of an incident by its id.",
  parameters: z.object({
    incidentId: z.string().describe("Incident id, for example INC-421"),
  }),
  async handler({ incidentId }) {
    const incident = await incidents.get(incidentId);
    return incident; // objects are serialized for the model
  },
});

// "Render a tool result as native UI"
// A tool can post a portable JSX message and return a brief acknowledgement to
// the model. The portable message renders as a Microsoft Teams Adaptive Card
// before Intelligence delivers it to the conversation.
export const showIncident = defineChannelTool({
  name: "show_incident",
  description: "Display an incident summary in the conversation.",
  parameters: z.object({
    id: z.string(),
    status: z.string(),
    summary: z.string(),
  }),
  async handler({ id, status, summary }, { thread }) {
    await thread.post(
      <Message>
        <Header>{`${id} · ${status}`}</Header>
        <Section>{summary}</Section>
      </Message>,
    );
    return `Displayed ${id}.`;
  },
});

// "Add stable context" -- passed to createChannel({ context }).
// Channel context transmits on each agent execution. Keep this collection small
// and stable; retrieve frequently updated information through tools rather than
// embedding outdated snapshots in prompts.
export const channelContext = [
  {
    description: "Support policy",
    value: "Never disclose credentials. Escalate Sev-1 incidents immediately.",
  },
  {
    description: "Response style",
    value: "Use short paragraphs and put the next action first.",
  },
];

// "Where MCP belongs"
//
// Connect MCP servers to the selected agent backend. The Channels SDK forwards
// channel tools over AG-UI alongside tools already exposed by that agent, so no
// separate channel-specific MCP transport is needed. Begin with MCP tools, then
// use `defineChannelTool` exclusively for actions that need the current channel
// conversation context -- as `show_incident` above does, since it posts into the
// live thread.
