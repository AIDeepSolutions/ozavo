import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

type Message = Record<string, unknown>;
type Waiter = { matches: (message: Message) => boolean; resolve: (message: Message) => void };

/**
 * Servidor WebSocket falso, em porta 0, que separa o JSON do áudio binário (a Deepgram recebe
 * áudio em quadro binário; o `startFakeProvider` dos vizinhos só entende JSON).
 */
export async function startFakeWs() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const unread: Message[] = [];
  const waiters: Waiter[] = [];
  const binary: Buffer[] = [];
  let client: WebSocket | undefined;
  const request = { url: "", headers: {} as IncomingHttpHeaders };
  let onConnect: () => void = () => undefined;
  const connected = new Promise<void>((resolve) => (onConnect = resolve));

  server.on("connection", (socket, incoming) => {
    client = socket;
    request.url = incoming.url ?? "";
    request.headers = incoming.headers;
    socket.on("message", (data, isBinary) => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (isBinary) {
        binary.push(bytes);
        return;
      }
      const message = JSON.parse(bytes.toString()) as Message;
      const index = waiters.findIndex((waiter) => waiter.matches(message));
      if (index === -1) unread.push(message);
      else waiters.splice(index, 1)[0]?.resolve(message);
    });
    onConnect();
  });

  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    request,
    connected,
    /** Áudio binário recebido até agora, colado. */
    binary: () => Buffer.concat(binary),
    waitFor(matches: (message: Message) => boolean): Promise<Message> {
      const index = unread.findIndex(matches);
      if (index !== -1) return Promise.resolve(unread.splice(index, 1)[0] as Message);
      return new Promise((resolve) => waiters.push({ matches, resolve }));
    },
    /** As mensagens JSON recebidas e ainda não lidas por `waitFor`. */
    unread,
    send(message: unknown): void {
      client?.send(typeof message === "string" ? message : JSON.stringify(message));
    },
    drop(): void {
      client?.terminate();
    },
    async stop(): Promise<void> {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export interface SseRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** O teste escreve a resposta: `write` manda um evento SSE (objeto vira JSON), `end` fecha. */
export interface SseReply {
  status(code: number, body?: unknown): void;
  write(data: unknown): void;
  /** Linha de comentário do SSE (o OpenRouter manda `: OPENROUTER PROCESSING`). */
  comment(text: string): void;
  end(): void;
  raw: ServerResponse;
}

/** Servidor HTTP falso, em porta 0, que responde Chat Completions em SSE como o teste mandar. */
export async function startFakeSse(handler: (request: SseRequest, reply: SseReply) => void | Promise<void>) {
  const requests: SseRequest[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      const request: SseRequest = { url: incoming.url ?? "", headers: incoming.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
      requests.push(request);
      let started = false;
      const start = (): void => {
        if (started) return;
        started = true;
        response.writeHead(200, { "content-type": "text/event-stream" });
      };
      const reply: SseReply = {
        status(code, body) {
          started = true;
          response.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body ?? {}));
        },
        write(data) {
          start();
          response.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
        },
        comment(text) {
          start();
          response.write(`: ${text}\n\n`);
        },
        end() {
          start();
          response.end("data: [DONE]\n\n");
        },
        raw: response,
      };
      void handler(request, reply);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    async stop(): Promise<void> {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Pedaço de texto no formato do Chat Completions em streaming. */
export const textChunk = (content: string) => ({ choices: [{ delta: { content } }] });

/** Pedaço de chamada de função, que pode vir partido em vários. */
export const toolChunk = (index: number, part: { id?: string; name?: string; arguments?: string }) => ({
  choices: [{ delta: { tool_calls: [{ index, ...(part.id && { id: part.id }), function: { ...(part.name && { name: part.name }), ...(part.arguments && { arguments: part.arguments }) } }] } }],
});

export const usageChunk = (prompt: number, completion: number, cost?: number, cached = 0) => ({
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion, ...(cost !== undefined && { cost }), prompt_tokens_details: { cached_tokens: cached } },
});

/** Relógio de mentira: o teste avança o tempo. */
export function manualClock(start = 1_800_000_000_000) {
  let now = start;
  return {
    clock: { now: () => new Date(now) },
    advance(ms: number): void {
      now += ms;
    },
    get ms(): number {
      return now;
    },
  };
}

/** Agendador manual: guarda os prazos e só dispara quando o teste manda. */
export function manualScheduler() {
  const jobs: { fn: () => void; delayMs: number; cancelled: boolean }[] = [];
  return {
    schedule(fn: () => void, delayMs: number): () => void {
      const job = { fn, delayMs, cancelled: false };
      jobs.push(job);
      return () => {
        job.cancelled = true;
      };
    },
    /** Prazos ainda pendentes. */
    pending: () => jobs.filter((job) => !job.cancelled).map((job) => job.delayMs),
    /** Dispara todos os prazos pendentes. */
    runAll(): void {
      for (const job of jobs.splice(0)) if (!job.cancelled) job.fn();
    },
  };
}

/**
 * Espera a condição valer, dando a vez ao laço de eventos (sockets, prazos do código). Nenhuma
 * asserção depende de quanto tempo passou: o limite só evita um teste preso para sempre.
 */
export async function until(condition: () => boolean, tries = 3_000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("a condição não chegou a valer");
}
