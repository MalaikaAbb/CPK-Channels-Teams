// ---------------------------------------------------------------------------
// NOT FROM THE DOCS.
//
// The seven doc pages reference application objects (`incidents`, `approvals`,
// `audit`, `feedback`) without defining them -- they are placeholders for your
// own services. These in-memory stand-ins exist only so the harness compiles
// and runs. Replace each one with your real service.
// ---------------------------------------------------------------------------

export interface Incident {
  id: string;
  status: string;
  summary: string;
  owner: string;
}

const incidentTable = new Map<string, Incident>([
  [
    "INC-421",
    {
      id: "INC-421",
      status: "investigating",
      summary: "Checkout latency is above the SLO.",
      owner: "Payments",
    },
  ],
  [
    "INC-422",
    {
      id: "INC-422",
      status: "resolved",
      summary: "Webhook retries exhausted for the billing consumer.",
      owner: "Billing",
    },
  ],
]);

export const incidents = {
  async get(incidentId: string): Promise<Incident | { error: string }> {
    return (
      incidentTable.get(incidentId) ?? {
        error: `No incident found with id ${incidentId}.`,
      }
    );
  },
  async list(): Promise<Incident[]> {
    return [...incidentTable.values()];
  },
};

export const approvals = {
  async forApplicationUser(userId: string) {
    return [{ id: "APR-1", assignee: userId, subject: "INC-421 rollback" }];
  },
};

export const audit = {
  record(entry: { emoji?: string; rawEmoji?: string; added: boolean }) {
    console.log("[audit] reaction", entry);
  },
};

export const feedback = {
  async record(answerId: string, userId?: string) {
    console.log("[feedback] answer", answerId, "from", userId ?? "unknown");
  },
};

// Used by the Teams form card in features/rich-messages.tsx, which demonstrates
// the Adaptive Card `Action.Submit` -> `ctx.values` path.
export const triage = {
  async record(entry: {
    incidentId: string;
    severity: unknown;
    note: unknown;
    userId?: string;
  }) {
    console.log("[triage] submission", entry);
  },
};
