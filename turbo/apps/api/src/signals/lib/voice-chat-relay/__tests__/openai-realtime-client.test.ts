import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { http, passthrough } from "msw";
import { delay } from "signal-timers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { server as mswServer } from "../../../../mocks/server";
import {
  buildSessionUpdate,
  createOpenAiRealtimeClient,
} from "../openai-realtime-client";

interface FakeOpenAi {
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly nextSocket: () => Promise<WebSocket>;
  readonly receivedAuthHeader: () => string | null;
}

async function startFakeOpenAi(): Promise<FakeOpenAi> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let lastAuthHeader: string | null = null;
  let pendingResolve: ((ws: WebSocket) => void) | null = null;
  const queued: WebSocket[] = [];

  httpServer.on("upgrade", (req, socket, head) => {
    lastAuthHeader =
      (req.headers["authorization"] as string | undefined) ?? null;
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (pendingResolve !== null) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(ws);
      } else {
        queued.push(ws);
      }
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port}`;

  return {
    url,
    async close() {
      await new Promise<void>((resolve) => {
        wss.close(() => {
          httpServer.close(() => {
            resolve();
          });
        });
      });
    },
    nextSocket() {
      return new Promise<WebSocket>((resolve) => {
        const popped = queued.shift();
        if (popped !== undefined) {
          resolve(popped);
          return;
        }
        pendingResolve = resolve;
      });
    },
    receivedAuthHeader() {
      return lastAuthHeader;
    },
  };
}

describe("createOpenAiRealtimeClient", () => {
  let fake: FakeOpenAi;

  beforeEach(async () => {
    // MSW (configured in src/__tests__/setup.ts with onUnhandledRequest:
    // "error") would otherwise intercept the WS upgrade request to our
    // local fake server. Allow loopback traffic through.
    mswServer.use(
      http.all(/127\.0\.0\.1/u, () => {
        return passthrough();
      }),
      http.all(/localhost/u, () => {
        return passthrough();
      }),
    );
    fake = await startFakeOpenAi();
  });

  afterEach(async () => {
    await fake.close();
  });

  it("connects with Authorization header and sends session.update on open", async () => {
    const client = createOpenAiRealtimeClient({
      url: fake.url,
      apiKey: "sk-test",
    });
    const socketPromise = fake.nextSocket();
    const openPromise = client.open({ instructions: "be helpful" });
    const ws = await socketPromise;

    const firstFrame = await new Promise<string>((resolve) => {
      ws.once("message", (data) => {
        resolve(data.toString("utf8"));
      });
    });

    expect(fake.receivedAuthHeader()).toBe("Bearer sk-test");
    expect(JSON.parse(firstFrame)).toStrictEqual(
      buildSessionUpdate({ instructions: "be helpful" }),
    );

    // Simulate session.created from server side; open() should resolve.
    ws.send(
      JSON.stringify({ type: "session.created", session: { id: "sess_x" } }),
    );
    const opened = await openPromise;
    expect(opened.openaiSessionId).toBe("sess_x");

    client.close(1000, "test done");
  });

  it("forwards parsed events to onEvent", async () => {
    const client = createOpenAiRealtimeClient({
      url: fake.url,
      apiKey: "sk-test",
    });
    const events: string[] = [];
    client.onEvent((event) => {
      events.push(event.kind);
    });
    const socketPromise = fake.nextSocket();
    const openPromise = client.open({ instructions: "x" });
    const ws = await socketPromise;
    ws.send(JSON.stringify({ type: "session.created", session: { id: "s1" } }));
    await openPromise;
    ws.send(
      JSON.stringify({
        type: "response.audio.delta",
        delta: "AAAA",
      }),
    );
    ws.send(
      JSON.stringify({
        type: "error",
        error: { message: "boom" },
      }),
    );

    // Allow the event loop a tick for messages to drain. signal-timers'
    // delay() requires an AbortSignal; this test doesn't model abort, so
    // pass a never-aborted signal.
    await delay(20, { signal: new AbortController().signal });
    expect(events).toContain("session.created");
    expect(events).toContain("passthrough");
    expect(events).toContain("error");
    client.close();
  });

  it("rejects open() if the server closes before session.created", async () => {
    const client = createOpenAiRealtimeClient({
      url: fake.url,
      apiKey: "sk-test",
    });
    const socketPromise = fake.nextSocket();
    const openPromise = client.open({ instructions: "x" });
    const ws = await socketPromise;
    ws.close(4000, "nope");
    await expect(openPromise).rejects.toThrow();
  });
});
