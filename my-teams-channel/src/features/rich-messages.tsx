// Source: https://docs.copilotkit.ai/teams/rich-messages
//
// Channels JSX does not use React at runtime. The TypeScript JSX transform is
// pointed at `@copilotkit/channels` in tsconfig.json:
//
//   { "jsx": "react-jsx", "jsxImportSource": "@copilotkit/channels" }
//
// Keep "type": "module" in package.json and use .tsx for files containing JSX.
//
// ---------------------------------------------------------------------------
// "Know what each provider renders" -- the Teams column of the page's table:
//
//   Message            flattens into an Adaptive Card; `accent` has no mapping
//   Header             large bold text block
//   Section, Markdown  wrapped Adaptive Card text
//   Fields, Field      fact set; derives a label from "Label: value" text
//   Context            small, subtle text
//   Actions, Button    top-level Action.Submit or Action.OpenUrl
//   Select, Input      Adaptive Card inputs
//   Image, Divider     image and separator
//   Table, Row, Cell   Adaptive Card 1.5 table
//   Chart              Teams chart extension where the client supports it
//
// Unknown or unsupported nodes are OMITTED rather than failing the whole
// message. That makes portable rendering resilient, but it also means the text
// around an optional visual must still carry the important result.
//
// Teams renders Adaptive Card version 1.5. Button style is translated to
// positive/destructive where possible; spacing, colors, and typography stay
// provider-owned. Managed Teams supports post, update, and delete frames.
// ---------------------------------------------------------------------------
import {
  Actions,
  Button,
  Chart,
  Cell,
  Context,
  Divider,
  Field,
  Fields,
  Header,
  Input,
  Message,
  Row,
  Section,
  Select,
  Table,
} from "@copilotkit/channels/ui";
import type { Thread } from "@copilotkit/channels";
import type { Incident } from "../services/fixtures.js";
import { triage } from "../services/fixtures.js";

// "Build a portable status card"
export function IncidentCard(props: {
  id: string;
  summary: string;
  owner: string;
  status: string;
}) {
  return (
    <Message>
      <Header>{`${props.id} · ${props.status}`}</Header>
      <Section>{props.summary}</Section>
      <Divider />
      <Fields>
        <Field>{`Owner: ${props.owner}`}</Field>
        <Field>{`Status: ${props.status}`}</Field>
      </Fields>
      <Context>Updated from the incident service</Context>
    </Message>
  );
}

// "Update a message safely"
//
// `thread.post()` returns a `MessageRef` that can be updated during the CURRENT
// managed delivery. Do not persist that ref and assume it remains updateable in
// a later delivery. For a later button click, use the interaction's
// `message.ref`, check that `message.ref.id` is non-empty, and treat the update
// as best-effort.
export async function postAndUpdateIncidentCard(
  thread: Pick<Thread, "post" | "update">,
  incident: { id: string; summary: string; owner: string },
) {
  const ref = await thread.post(
    <IncidentCard {...incident} status="Loading" />,
  );

  await thread.update(
    ref,
    <IncidentCard {...incident} status="Investigating" />,
  );
}

// ---------------------------------------------------------------------------
// NOT FROM THE DOCS (but it exercises a documented Teams-only behavior).
//
// The page states: "Managed Slack dispatches those controls directly. Managed
// Teams renders Adaptive Card fields and submits them with a Button's
// Action.Submit; that Button callback receives the other named fields in
// `ctx.values`. Teams does not dispatch `Select.onSelect` or `Input.onSubmit`
// independently."
//
// So on Teams the `name` props are load-bearing and the SUBMIT BUTTON is the
// only handler that fires. `onSelect`/`onSubmit` are deliberately omitted here:
// adding them would work on Slack and be silently dead on Teams.
//
// Register in createChannel({ components: [TriageForm] }) -- it has a callback.
// ---------------------------------------------------------------------------
export function TriageForm({ incidentId }: { incidentId: string }) {
  return (
    <Message>
      <Header>{`Triage ${incidentId}`}</Header>
      <Section>Set a severity and add a short note, then submit.</Section>
      <Select
        name="severity"
        placeholder="Select a severity"
        options={[
          { label: "Sev-1 — customer outage", value: "sev1" },
          { label: "Sev-2 — degraded", value: "sev2" },
          { label: "Sev-3 — minor", value: "sev3" },
        ]}
      />
      <Input name="note" placeholder="What did you observe?" multiline />
      <Actions>
        <Button
          style="primary"
          value={{ incidentId }}
          onClick={async ({ thread, values, action, user }) => {
            // `values` carries the other named Adaptive Card fields; `action.value`
            // carries this button's own payload.
            const severity = values.severity ?? "(none selected)";
            const note = values.note ?? "(no note)";

            await triage.record({
              incidentId: action.value?.incidentId ?? incidentId,
              severity,
              note,
              userId: user?.id,
            });

            await thread.post(
              <Message>
                <Header>{`Triage recorded for ${incidentId}`}</Header>
                <Fields>
                  <Field>{`Severity: ${severity}`}</Field>
                  <Field>{`Note: ${note}`}</Field>
                </Fields>
              </Message>,
            );
          }}
        >
          Submit triage
        </Button>
      </Actions>
    </Message>
  );
}

// NOT FROM THE DOCS: renders the two nodes with the most provider variance --
// `Table` (Adaptive Card 1.5) and `Chart` (a Teams chart extension that clients
// may omit).
//
// Per the page, "Pair every chart with a text summary" -- the <Context> line
// below is that summary, so the message still carries the result on a client
// that drops the chart node.
export function IncidentDigest({ incidents }: { incidents: Incident[] }) {
  const open = incidents.filter((i) => i.status !== "resolved").length;

  return (
    <Message>
      <Header>Incident digest</Header>
      <Table
        columns={[
          { header: "Incident" },
          { header: "Owner" },
          { header: "Status", align: "right" },
        ]}
      >
        {incidents.map((incident) => (
          <Row>
            <Cell>{incident.id}</Cell>
            <Cell>{incident.owner}</Cell>
            <Cell>{incident.status}</Cell>
          </Row>
        ))}
      </Table>
      <Chart
        type="donut"
        title="Incidents by status"
        data={[
          { label: "Open", value: open },
          { label: "Resolved", value: incidents.length - open },
        ]}
      />
      <Context>{`${open} open of ${incidents.length} tracked incidents.`}</Context>
    </Message>
  );
}

// ---------------------------------------------------------------------------
// "Keep provider-specific payloads at the edge"
//
// The `{ raw: nativePayload, provider }` escape hatch is part of the low-level
// renderable type, but it is NOT portable. Tag a Teams Adaptive Card object with
// `provider: "teams"` (and Slack Block Kit with `provider: "slack"`); a provider
// mismatch fails explicitly before the effect reaches the provider. Prefer
// Channels components in shared managed code -- this harness uses no raw
// payloads at all.
// ---------------------------------------------------------------------------
