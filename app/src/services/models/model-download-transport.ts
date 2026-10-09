import { Agent, request, type AgentOptions, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { Socket } from "node:net";

export const MODEL_DOWNLOAD_CHUNK_BYTES = 64 * 1024;
export interface DownloadHeaders { readonly status: number; readonly raw: readonly string[] }
/** Host-only effects. An exchange is owned before any asynchronous headers. */
export interface ModelDownloadExchange {
  readonly headers: Promise<DownloadHeaders>;
  readonly body: AsyncIterable<Uint8Array>;
  completion(): Readonly<{ complete: boolean; failed: boolean }>;
  /** The same request/response/socket close operation, including late failure. */
  close(): Promise<void>;
}
export interface ModelDownloadTransport {
  request(url: URL, method: "HEAD" | "GET", signal: AbortSignal): ModelDownloadExchange;
  close(): Promise<void>;
}
/** Inert request effects are injectable by host tests, never by IPC input. */
export interface ModelDownloadHTTPSIO {
  createAgent(options: AgentOptions): Agent;
  request(url: URL, options: RequestOptions, response: (message: IncomingMessage) => void): ClientRequest;
}
export class ModelDownloadTransportError extends Error {
  constructor() { super("DOWNLOAD_TRANSPORT_FAILED"); this.name = "ModelDownloadTransportError"; }
}

/** Fixed public HTTPS policy. No global Agent, cookie, token, environment proxy
 * or certificate override is used. This factory performs no request itself. */
export function createModelDownloadTransport(io: ModelDownloadHTTPSIO = {
  createAgent: (options) => new Agent(options), request,
}): ModelDownloadTransport {
  return createPublicHTTPSTransport((hostname) => ["hf.co", "huggingface.co"]
    .some((host) => hostname === host || hostname.endsWith(`.${host}`)), io);
}

/** Fixed updater hosts only; exact asset and redirect admission remain the download owner's responsibility. */
export function createUpdateDownloadTransport(io: ModelDownloadHTTPSIO = {
  createAgent: (options) => new Agent(options), request,
}): ModelDownloadTransport {
  return createPublicHTTPSTransport((hostname) => ["github.com", "release-assets.githubusercontent.com"].includes(hostname), io);
}

/** Public release metadata only. Exact endpoint/redirect admission stays with the feed reader. */
export function createUpdateFeedTransport(io: ModelDownloadHTTPSIO = {
  createAgent: (options) => new Agent(options), request,
}): ModelDownloadTransport {
  return createPublicHTTPSTransport((hostname) => ["api.github.com", "github.com", "release-assets.githubusercontent.com"].includes(hostname),
    io, { "User-Agent": "OpenWhisper" });
}

function createPublicHTTPSTransport(allowedHost: (hostname: string) => boolean, io: ModelDownloadHTTPSIO,
  publicHeaders: Readonly<Record<string, string>> = {}): ModelDownloadTransport {
  const agent = io.createAgent({ keepAlive: false, rejectUnauthorized: true, proxyEnv: {} });
  const exchanges = new Set<ModelDownloadExchange>(); let closing: Promise<void> | undefined;
  return {
    request(url, method, signal) {
      if (closing || signal.aborted || url.protocol !== "https:" || (url.port && url.port !== "443") ||
          url.username || url.password || url.hash || url.hostname.endsWith(".") ||
          !allowedHost(url.hostname)) {
        throw new ModelDownloadTransportError();
      }
      let response: IncomingMessage | undefined, socket: Socket | undefined, owned: ClientRequest | undefined;
      let requestClosed = false, responseClosed = false, socketClosed = false, failed = false, destroying = false;
      let acceptHeaders!: (headers: DownloadHeaders) => void, rejectHeaders!: (error: Error) => void;
      let acceptResponse!: (message: IncomingMessage) => void, rejectResponse!: (error: Error) => void;
      let acceptClosed!: () => void;
      const closed = new Promise<void>((accept) => { acceptClosed = accept; });
      const headers = new Promise<DownloadHeaders>((accept, reject) => { acceptHeaders = accept; rejectHeaders = reject; });
      const incoming = new Promise<IncomingMessage>((accept, reject) => { acceptResponse = accept; rejectResponse = reject; });
      // Both promises are owned even when cancellation happens before headers.
      void headers.catch(() => {}); void incoming.catch(() => {});
      const checkClosed = (): void => {
        if (requestClosed && (!response || responseClosed) && (!socket || socketClosed)) {
          signal.removeEventListener("abort", abort); acceptClosed();
        }
      };
      const destroy = (): void => {
        destroying = true;
        if (owned && !owned.destroyed) owned.destroy();
        if (response && !response.destroyed) response.destroy();
        if (socket && !socket.destroyed) socket.destroy();
        checkClosed();
      };
      const failure = (): void => {
        failed = true; rejectHeaders(new ModelDownloadTransportError()); rejectResponse(new ModelDownloadTransportError()); destroy();
      };
      const abort = (): void => { failure(); };
      const exchange: ModelDownloadExchange = {
        headers,
        body: { async *[Symbol.asyncIterator]() {
          const message = await incoming;
          try {
            for await (const chunk of message) {
              if (!(chunk instanceof Uint8Array)) throw new ModelDownloadTransportError();
              // IncomingMessage does not guarantee an application-level chunk ceiling.
              for (let offset = 0; offset < chunk.length; offset += MODEL_DOWNLOAD_CHUNK_BYTES) {
                yield chunk.subarray(offset, offset + MODEL_DOWNLOAD_CHUNK_BYTES);
              }
            }
          } catch { failed = true; throw new ModelDownloadTransportError(); }
        } },
        completion: () => Object.freeze({ complete: response?.complete === true, failed }),
        close: () => { destroy(); return closed; },
      };
      exchanges.add(exchange);
      try {
        owned = io.request(url, { method, agent, rejectUnauthorized: true, headers: { ...publicHeaders, "Accept-Encoding": "identity" },
          maxHeaderSize: 16 * 1024 }, (message) => {
          response = message;
          message.once("error", failure); message.once("aborted", failure);
          message.once("close", () => { responseClosed = true; if (!destroying && !message.complete) failed = true; checkClosed(); });
          acceptResponse(message);
          acceptHeaders(Object.freeze({ status: message.statusCode ?? 0, raw: Object.freeze([...message.rawHeaders]) }));
          if (destroying || signal.aborted) destroy();
        });
        owned.once("error", failure);
        owned.once("close", () => { requestClosed = true; if (!response && !destroying) failure(); checkClosed(); });
        owned.once("socket", (value: Socket) => {
          // Destroy intent is not a close certificate, including a socket
          // already marked destroyed when its ownership is transferred.
          socket = value;
          value.once("error", failure); value.once("close", () => { socketClosed = true; checkClosed(); });
          if (destroying || signal.aborted) destroy();
        });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort(); else owned.end();
      } catch {
        // A synchronous request-factory failure cannot have transferred an
        // unreturned owner under this closed effect contract.
        requestClosed = owned === undefined; failure();
      }
      return exchange;
    },
    close() {
      closing ??= Promise.resolve().then(async () => {
        agent.destroy(); await Promise.all([...exchanges].map((exchange) => exchange.close()));
      });
      return closing;
    },
  };
}
