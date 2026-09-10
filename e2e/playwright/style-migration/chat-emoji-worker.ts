import assert from "node:assert/strict";

interface WorkerRequest {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string> };
}

// SharedWorker fetches do not go through Playwright's Page/Context routing.
// Intercept only the external API boundary; execute the deployed worker intact.
export async function installChatEmojiWorkerFixture(
  apiOrigin: string,
  fixtures: () => Record<string, unknown>,
  failures: string[],
) {
  const metadata: { webSocketDebuggerUrl: string } = await (
    await fetch("http://127.0.0.1:9227/json/version")
  ).json();
  const socket = new WebSocket(metadata.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Cannot open fixture CDP")),
      { once: true },
    );
  });
  let nextId = 1;
  const paths = new Set<string>();
  const pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  const send = (
    sessionId: string | undefined,
    method: string,
    params: object = {},
  ) =>
    new Promise<void>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  socket.addEventListener("message", (message) => {
    assert.equal(typeof message.data, "string");
    const packet: {
      id?: number;
      sessionId?: string;
      method?: string;
      error?: { message: string };
      params?: WorkerRequest & { sessionId: string };
    } = JSON.parse(String(message.data));
    if (packet.id) {
      const task = pending.get(packet.id);
      pending.delete(packet.id);
      if (packet.error) task?.reject(new Error(packet.error.message));
      else task?.resolve();
      return;
    }
    if (packet.method === "Target.attachedToTarget" && packet.params) {
      const sessionId = packet.params.sessionId;
      void (async () => {
        await send(sessionId, "Fetch.enable", {
          patterns: [{ urlPattern: `${apiOrigin}/*`, requestStage: "Request" }],
        });
        await send(sessionId, "Runtime.runIfWaitingForDebugger");
      })().catch((error: unknown) =>
        failures.push(`Worker attach: ${String(error)}`),
      );
      return;
    }
    const sessionId = packet.sessionId;
    const event = packet;
    if (event.method !== "Fetch.requestPaused" || !event.params || !sessionId)
      return;
    const { request, requestId } = event.params;
    void (async () => {
      const url = new URL(request.url);
      if (url.origin !== apiOrigin) throw new Error("Unexpected worker origin");
      paths.add(`${request.method} ${url.pathname}`);
      const cors = [
        { name: "Content-Type", value: "application/json" },
        {
          name: "Access-Control-Allow-Origin",
          value: request.headers.Origin ?? request.headers.origin ?? "*",
        },
        { name: "Access-Control-Allow-Credentials", value: "true" },
        { name: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
        {
          name: "Access-Control-Allow-Headers",
          value:
            request.headers["Access-Control-Request-Headers"] ??
            request.headers["access-control-request-headers"] ??
            "authorization,content-type,x-okou-chat-event-schema-version,x-vercel-protection-bypass",
        },
      ];
      if (request.method === "OPTIONS") {
        await send(sessionId, "Fetch.fulfillRequest", {
          requestId,
          responseCode: 204,
          responseHeaders: cors,
        });
        return;
      }
      const value = fixtures()[url.pathname];
      if (value !== undefined && request.method === "GET") {
        await send(sessionId, "Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: cors,
          body: Buffer.from(JSON.stringify(value)).toString("base64"),
        });
      } else if (url.pathname.endsWith("/event-snapshot")) {
        await send(sessionId, "Fetch.fulfillRequest", {
          requestId,
          responseCode: 404,
          responseHeaders: cors,
          body: Buffer.from(
            JSON.stringify({
              error: {
                code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
                message: "Chat event snapshot not found",
              },
            }),
          ).toString("base64"),
        });
      } else if (url.pathname === "/api/chat/events/catch-up") {
        const id = Object.keys(fixtures())
          .find((key) => key.endsWith("/event-rows"))
          ?.split("/")[3];
        if (!id) throw new Error("Missing fixture thread");
        await send(sessionId, "Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: cors,
          body: Buffer.from(
            JSON.stringify({ events: { [id]: [] }, notFoundThreads: [] }),
          ).toString("base64"),
        });
      } else {
        if (
          request.method !== "GET" &&
          request.method !== "OPTIONS" &&
          url.pathname !== "/api/realtime/token"
        ) {
          throw new Error(
            `Unexpected worker write: ${request.method} ${url.pathname}`,
          );
        }
        const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
        await send(sessionId, "Fetch.continueRequest", {
          requestId,
          ...(secret
            ? {
                headers: Object.entries({
                  ...request.headers,
                  "x-vercel-protection-bypass": secret,
                }).map(([name, value]) => ({ name, value })),
              }
            : {}),
        });
      }
    })().catch(async (error: unknown) => {
      failures.push(`Worker fixture: ${String(error)}`);
      await send(sessionId, "Fetch.failRequest", {
        requestId,
        errorReason: "BlockedByClient",
      });
    });
  });
  await send(undefined, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "shared_worker" }, { exclude: true }],
  });
  return {
    paths,
    close: async () => {
      await send(undefined, "Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      socket.close();
    },
  };
}
