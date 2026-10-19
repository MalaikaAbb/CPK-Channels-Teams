import { createServer } from "node:http";
import {
  CopilotKitIntelligence,
  CopilotRuntime,
} from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";

import { channel } from "./channel.js";
import { required } from "./env.js";

const intelligence = new CopilotKitIntelligence({
  apiKey: required("INTELLIGENCE_API_KEY"),
  // Managed deployments use the hosted defaults. Override both URLs
  // together only for self-hosted or non-production Intelligence.
  apiUrl: process.env.INTELLIGENCE_API_URL,
  wsUrl: process.env.INTELLIGENCE_GATEWAY_WS_URL,
});

const runtime = new CopilotRuntime({
  agents: {},
  intelligence,
  channels: [channel],
});

// Wire teardown before the listener exists, because creating it is what
// starts the Channel. A Ctrl-C during the connect window then still tears
// the Channel down instead of hitting Node's default handler.
//
// /teams/threads-and-state: "Stop the listener on SIGINT and SIGTERM so
// Intelligence can release the runtime cleanly."
let teardown: (() => Promise<void>) | undefined;
const shutdown = async () => {
  await teardown?.();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

const listener = createCopilotNodeListener({
  runtime,
  basePath: "/api/copilotkit",
});
const channels = listener.channels;
const server = createServer(listener);
teardown = async () => {
  await channels.stop();
  if (server.listening) server.close();
};

// Optional: block startup until the activation above settles, so a broken
// deploy fails loudly instead of serving as a bot that never answers.
//
// "Online" only confirms a healthy managed connection that can receive delivery
// invitations. It does NOT prove that workflow state survives a restart -- see
// features/threads-and-state.ts.
await channels.ready({ timeoutMs: 30_000 });
const status = channels.status();
if (status.overall !== "online") {
  throw new Error(`Teams Channel is not online: ${JSON.stringify(status)}`);
}

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`Teams Channel online; lifecycle server listening on :${port}`);
});
