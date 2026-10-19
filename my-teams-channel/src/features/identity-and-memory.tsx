// Source: https://docs.copilotkit.ai/teams/identity-and-memory
import type { ChannelIdentifyUser } from "@copilotkit/channels";
import {
  Actions,
  Button,
  Header,
  Message,
  Section,
} from "@copilotkit/channels/ui";

// ---------------------------------------------------------------------------
// "Separate the conversation, actor, and application user"
//
//   Conversation      Teams chat, channel, or thread -> the Channels `Thread`
//   Actor             Teams account that caused THIS event (resolved per event)
//   Application user  Canonical user your `identifyUser` policy returns
//
// A `Thread` has no personal owner. The person who installed the app, started
// the conversation, or sent the first message does NOT become the Memory
// subject for later participants. Resolve the current actor on every event.
// ---------------------------------------------------------------------------

// "Map the current provider actor"
//
// For Microsoft Teams, `tenant.id` identifies the Microsoft tenant and
// `actor.id` identifies the Teams account. Team channels and group chats can
// contain several actors, so the external-identity key INCLUDES the tenant --
// this is the documented Teams key, and unlike the Slack page it is load-bearing
// here.
//
// Replace the map with a lookup in the account-linking data your application
// owns. Do not automatically link accounts by email address, display name, or
// handle -- those can change or collide across provider tenants.
const linkedAccounts = new Map([
  // Keyed WITHOUT the tenant, because managed Teams reports tenant.id
  // "unknown" on this deployment (see the warning below). The docs' scoped
  // form is "teams:${tenant.id}:${actor.id}"; keying on a placeholder tenant
  // would bake "unknown" into the key and break silently the day Intelligence
  // starts populating the field. The unscoped entry keeps matching either way.
  //
  // The actor id is a Teams MRI and CONTAINS colons -- never split these keys
  // on ":" to recover their parts. Look them up whole.
  [
    "teams:29:1fQp8TmijC-kK9FZ2pD5kkIu_tMLf0vqNUYrKZNG8l-DPB0SrL3agwuLm0kuHUL6qQTW0lvv26tjkW6f7Pi3iuA",
    { id: "user_42", name: "Ada Lovelace" },
  ],
]);

// The Microsoft tenant this Channel is provisioned against -- the tenant behind
// MalaikaAbbasi@Fiqros.onmicrosoft.com, captured from Microsoft sign-in.
//
// This is NOT the value `identifyUser` receives today: managed Teams reports
// `tenant.id === "unknown"`, so a `linkedAccounts` entry keyed on this string
// would never match. It is recorded so the single-tenant assumption above is
// ENFORCED rather than merely assumed -- see the guard in identifyUser.
//
// The account's email address is a human-readable label only. Never key identity
// on an email, display name, or handle: they change and collide across tenants.
const EXPECTED_TENANT = "4a9a274f-28cb-48eb-9c3d-f9614979e2dd";

let dumpedContext = false;
let warnedUnknownTenant = false;

export const identifyUser: ChannelIdentifyUser = async (context) => {
  const { provider, tenant, actor } = context;

  // The documented Teams key.
  const scopedKey = `${provider}:${tenant.id}:${actor.id}`;
  // Fallback only. `tenant`/`installation` are OPTIONAL on the prepared
  // delivery; when Intelligence omits one the SDK substitutes
  // `{ id: "unknown" }`, which would bake a placeholder into every key.
  const unscopedKey = `${provider}:${actor.id}`;

  if (tenant.id === "unknown") {
    if (!warnedUnknownTenant) {
      warnedUnknownTenant = true;
      console.warn(
        "[identity] Intelligence sent no tenant; falling back to the unscoped " +
          `key "${unscopedKey}". Cross-tenant isolation is NOT enforced while ` +
          "this is true -- do not attach a second Microsoft tenant.",
      );
    }
  } else if (tenant.id !== EXPECTED_TENANT) {
    // Intelligence has started sending a real tenant AND it is not the one this
    // Channel was provisioned against. Refuse rather than let a foreign tenant's
    // actor id collide with an entry in `linkedAccounts` -- those entries are
    // unscoped precisely because no tenant was available when they were written.
    console.warn(
      `[identity] Refusing actor from unexpected tenant "${tenant.id}" ` +
        `(expected "${EXPECTED_TENANT}"). Re-scope linkedAccounts to the ` +
        "tenant-qualified key before serving more than one tenant.",
    );
    return null;
  }

  // HARNESS DIAGNOSTIC: dump the identity context once, to show exactly what
  // Intelligence sends for Teams. Only structural fields and the KEYS of `raw`
  // are logged -- never raw values, which can contain message content.
  if (!dumpedContext) {
    dumpedContext = true;
    console.log("[identity] first-event context:", {
      provider,
      tenant,
      installation: context.installation,
      conversation: context.conversation,
      trigger: context.trigger,
      actorKind: (actor as { kind?: string }).kind,
      hasLookupProfile: typeof context.lookupProfile === "function",
      rawKeys: Object.keys((context.raw ?? {}) as object),
      eventKeys: Object.keys(context.event ?? {}),
    });
  }

  const user =
    linkedAccounts.get(scopedKey) ?? linkedAccounts.get(unscopedKey) ?? null;

  // HARNESS DIAGNOSTIC (not from the docs): the map above ships with the docs'
  // placeholder IDs, which match nobody. This prints the real key for each
  // inbound actor so you can paste it into `linkedAccounts`. Remove for
  // production -- it logs provider account IDs on every event.
  console.log(
    `[identity] ${scopedKey} -> ${user ? `${user.id} (${user.name})` : "null (unlinked)"}`,
  );

  // Returning `null` means the actor is deliberately unlinked. Throw only when
  // the identity system itself failed.
  //
  // When the adapter provides `lookupProfile`, you may use it to enrich a
  // CONFIRMED provider identity -- but profile data never establishes a
  // canonical application account by itself.
  return user;
};

// "Grant Memory for one run"
// Intelligence Memory is off unless the current `runAgent` call grants access.
// Each `user` or `project` scope accepts "none", "read", or "read-write".
// Omitting a scope disables it for that run.
export const memoryGrant = {
  user: "read",
  project: "read-write",
} as const;

// Project-only Memory works when `identifyUser` returns `null`; user Memory
// fails before the agent starts unless the current event resolved to an
// application user (`channel_memory_user_required`).
//
// In a shared Teams channel or group chat, project Memory is the safer default.
// Grant user Memory only when the current turn clearly acts for the resolved
// individual. Never reuse the installer, thread creator, or first participant as
// the personal Memory subject for everyone else.
export const projectMemoryGrant = {
  project: "read-write",
} as const;

// ---------------------------------------------------------------------------
// "Choose the subject when resuming an approval"
//
//   "initiator" -- the application user who started the continuation chain
//   "actor"     -- the application user resolved for the current interaction
//   Project-only Memory needs no subject.
//   Callers cannot provide an arbitrary raw user ID.
//
// Use "initiator" when an approval belongs to the person who started the
// workflow; "actor" when the current approver should supply personal context.
//
// NOTE: this is a FRAGMENT, exactly as the docs define it -- a bare <Button>
// with no <Message>/<Actions> wrapper. Renderers omit nodes they cannot place at
// the top level, so posting it directly produces an empty card. The page never
// posts it; it points at /teams/interactive for "the complete registered
// component". Use ApprovalButtonCard below to post it.
// ---------------------------------------------------------------------------
export function ApprovalButton() {
  return (
    <Button
      value={{ approved: true }}
      onClick={async ({ thread, action }) => {
        const value = action.value;
        if (value === undefined) {
          await thread.post("The approval value was missing.");
          return;
        }

        await thread.resume(value, {
          memory: {
            user: "read",
            project: "read",
          },
          subject: "initiator",
        });
      }}
    >
      Approve
    </Button>
  );
}

// NOT FROM THE DOCS: a postable wrapper so the `subject` demo above can actually
// be rendered. ApprovalButton is left byte-for-byte as documented.
//
// Clicking it still requires a pending interaction continuation -- otherwise
// `thread.resume()` throws ChannelContinuationRequiredError ("Channel resume
// requires a valid interaction continuation").
export function ApprovalButtonCard({ summary }: { summary: string }) {
  return (
    <Message>
      <Header>Approval required</Header>
      <Section>{summary}</Section>
      <Actions>
        <ApprovalButton />
      </Actions>
    </Message>
  );
}

// ---------------------------------------------------------------------------
// "Handle stable identity and Memory failures"
//
// Identity and Memory validation fails BEFORE the agent runs, with stable codes:
//
//   channel_identity_invalid         identifyUser returned neither null nor a
//                                    non-empty { id, name } user
//   channel_identity_failed          the custom identity resolver threw
//   channel_memory_grant_invalid     a Memory scope used an unsupported value
//   channel_memory_user_required     user Memory requested with no resolved
//                                    application user
//   channel_memory_unavailable       no Intelligence Memory-capable runtime or
//                                    adapter is attached
//   channel_memory_subject_required  a resumed run requested user Memory without
//                                    "initiator" or "actor"
//
// "Verify the identity boundary" (run before enabling in a shared conversation):
//   1. Message from two actors in one conversation; confirm each event resolves
//      its own application user from the full provider/tenant/actor tuple.
//   2. Test an intentionally unlinked actor: a project-only run works; user
//      Memory fails with `channel_memory_user_required`.
//   3. Start a workflow as one user and click it as another; verify "initiator"
//      preserves the starter and "actor" selects the current approver.
//   4. Log the stable error code and your application user id -- never provider
//      tokens, message contents, or Memory contents.
// ---------------------------------------------------------------------------
