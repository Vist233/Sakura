// The JSON-RPC link: the only file that imports the ACP SDK. It turns the SDK's handler calls into the plain calls of
// `AgentHandlers`, turns `AcpError` into JSON-RPC errors, and gives the agent a `ClientChannel` to send updates through. The SDK
// checks every message in both directions against the protocol schema.
import { agent, methods, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";
import type { AgentContext } from "@agentclientprotocol/sdk";
import type { AgentHandlers } from "./agent.ts";
import type { Logger } from "./log.ts";
import { AcpError } from "./types.ts";
import type { AcpUpdate, ClientChannel } from "./types.ts";

export interface Streams {
  /** Bytes from the client. */
  input: ReadableStream<Uint8Array>;
  /** Bytes to the client. */
  output: WritableStream<Uint8Array>;
}

export interface Connection {
  /** Resolves when the client has closed its end or the stream failed. */
  readonly closed: Promise<void>;
}

/** A handler's `AcpError` must reach the client as the JSON-RPC error it describes. */
async function answering<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AcpError) throw new RequestError(error.code, error.message, error.data);
    throw error;
  }
}

const channelFor = (client: AgentContext): ClientChannel => ({
  update: (sessionId: string, update: AcpUpdate) => client.notify(methods.client.session.update, { sessionId, update }),
});

export function connect(handlers: AgentHandlers, streams: Streams, log: Logger): Connection {
  const app = agent({ name: "sakuracode" })
    .onRequest(methods.agent.initialize, ({ params }) => answering(() => handlers.initialize(params)))
    .onRequest(methods.agent.authenticate, ({ params }) => answering(() => handlers.authenticate(params)))
    .onRequest(methods.agent.session.new, ({ params }) => answering(() => handlers.newSession(params)))
    .onRequest(methods.agent.session.prompt, async ({ params, client, signal }) => {
      return answering(() => handlers.prompt(params, channelFor(client), signal));
    })
    .onRequest(methods.agent.session.setConfigOption, async ({ params, client }) => {
      return answering(() => handlers.setConfigOption(params, channelFor(client)));
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => handlers.cancel(params));

  const connection = app.connect(ndJsonStream(streams.output, streams.input));
  void connection.closed.catch((error: unknown) => log.warn(`connection closed with an error: ${error instanceof Error ? error.message : String(error)}`));
  return { closed: connection.closed.catch(() => undefined) };
}
