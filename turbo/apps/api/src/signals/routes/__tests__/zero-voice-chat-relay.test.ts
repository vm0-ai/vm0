import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { serve } from "@hono/node-server";
import {
  signRelayToken,
  type SignInput,
} from "@vm0/core/voice-chat/relay-token";
import { delay } from "signal-timers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient, WebSocketServer } from "ws";

import { now } from "../../../lib/time";
import { createAppWithWebSocket } from "../../../app-factory";
import { server as mswServer } from "../../../mocks/server";
import { createInMemoryRelaySessionRepository } from "../../lib/voice-chat-relay/relay-session-repository";

// 32-byte hex secret (64 hex chars) matching the env-stub value the route
// reads at upgrade time. Both sides must use this exact string.
const SECRET =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

interface FakeOpenAi {
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly autoSendSessionCreated: (sessionId: string) => void;
}

async function startFakeOpenAi(): Promise<FakeOpenAi> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let nextSessionId: string | null = null;
  httpServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Drain the relay's session.update frame, then emit session.created.
      ws.once("message", () => {
        if (nextSessionId !== null) {
          ws.send(
            JSON.stringify({
              type: "session.created",
              session: { id: nextSessionId },
            }),
          );
        }
      });
    });
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    autoSendSessionCreated: (id) => {
      nextSessionId = id;
    },
    close: () => {
      return new Promise<void>((resolve) => {
        wss.close(() => {
          httpServer.close(() => {
            resolve();
          });
        });
      });
    },
  };
}

interface BrowserConnection {
  readonly url: string;
  readonly close: () => Promise<void>;
}

async function startApp(opts: {
  readonly openAiUrl: string;
  readonly repo: ReturnType<typeof createInMemoryRelaySessionRepository>;
}): Promise<BrowserConnection & { readonly server: ReturnType<typeof serve> }> {
  const controller = new AbortController();
  const { app, injectWebSocket } = createAppWithWebSocket({
    signal: controller.signal,
    relayRepository: opts.repo,
    relayOpenAiUrl: opts.openAiUrl,
  });
  const server = serve({ fetch: app.fetch, port: 0 });
  injectWebSocket(server);
  // @hono/node-server returns a Node http server eventually; wait for listen.
  await new Promise<void>((resolve) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once("listening", () => {
      return resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}/api/zero/voice-chat/relay`,
    close: () => {
      return new Promise<void>((resolve) => {
        controller.abort();
        server.close(() => {
          return resolve();
        });
      });
    },
    server,
  };
}

function freshClaims(overrides: Partial<SignInput> = {}): SignInput {
  return {
    voiceChatSessionId: "00000000-0000-0000-0000-000000000001",
    userId: "user_test",
    orgId: "org_test",
    nowSeconds: Math.floor(now() / 1000),
    ...overrides,
  };
}

describe("voice-chat relay route", () => {
  let fakeOpenAi: FakeOpenAi;

  // MSW intercepts all outbound http calls; for these tests we open WS
  // connections to in-process loopback servers, and MSW's interceptor
  // mangles the 101 Switching Protocols response. Easier to fully disable
  // MSW for the lifetime of the file than to coerce passthrough to honour
  // the upgrade semantics — no other test in this file talks to MSW-mocked
  // hosts.
  beforeAll(() => {
    mswServer.close();
  });

  beforeEach(async () => {
    fakeOpenAi = await startFakeOpenAi();
  });

  afterEach(async () => {
    await fakeOpenAi.close();
  });

  it("happy path: valid token → relay.ready envelope and active row", async () => {
    fakeOpenAi.autoSendSessionCreated("sess_abc");
    const repo = createInMemoryRelaySessionRepository();
    const conn = await startApp({ openAiUrl: fakeOpenAi.url, repo });
    const { token } = signRelayToken(freshClaims(), SECRET);

    const ws = new WsClient(`${conn.url}?token=${encodeURIComponent(token)}`);
    const firstFrame = await new Promise<string>((resolve, reject) => {
      ws.once("message", (data) => {
        resolve(data.toString("utf8"));
      });
      ws.once("error", (err) => {
        reject(err);
      });
    });
    const envelope = JSON.parse(firstFrame) as {
      type: string;
      relaySessionId?: string;
      openaiSessionId?: string;
    };
    expect(envelope.type).toBe("relay.ready");
    expect(envelope.openaiSessionId).toBe("sess_abc");
    expect(envelope.relaySessionId).toBeDefined();

    expect(
      repo.list().some((r) => {
        return r.status === "active";
      }),
    ).toBeTruthy();

    ws.close();
    // signal-timers' delay() requires an AbortSignal; this test doesn't
    // model abort, so pass a never-aborted signal.
    await delay(50, { signal: new AbortController().signal });
    await conn.close();
  });

  it("rejects a malformed token with WS close 4400", async () => {
    const repo = createInMemoryRelaySessionRepository();
    const conn = await startApp({ openAiUrl: fakeOpenAi.url, repo });

    const ws = new WsClient(`${conn.url}?token=garbage`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.once("close", (code) => {
        resolve(code);
      });
    });
    expect(closeCode).toBe(4400);
    expect(repo.list()).toHaveLength(0);
    await conn.close();
  });

  it("rejects an expired token with WS close 4401", async () => {
    const repo = createInMemoryRelaySessionRepository();
    const conn = await startApp({ openAiUrl: fakeOpenAi.url, repo });
    // Sign with a `nowSeconds` 60+ seconds in the past so the default
    // RELAY_TOKEN_TTL_SECONDS=60 puts `exp` before the verifier's `now`.
    const { token } = signRelayToken(
      freshClaims({ nowSeconds: Math.floor(now() / 1000) - 120 }),
      SECRET,
    );

    const ws = new WsClient(`${conn.url}?token=${encodeURIComponent(token)}`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.once("close", (code) => {
        resolve(code);
      });
    });
    expect(closeCode).toBe(4401);
    expect(repo.list()).toHaveLength(0);
    await conn.close();
  });

  it("rejects a wrong-signature token with WS close 4401", async () => {
    const repo = createInMemoryRelaySessionRepository();
    const conn = await startApp({ openAiUrl: fakeOpenAi.url, repo });
    // Sign with a different (still 32-byte hex) secret so the verifier sees
    // a bad signature.
    const { token } = signRelayToken(
      freshClaims(),
      "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
    );

    const ws = new WsClient(`${conn.url}?token=${encodeURIComponent(token)}`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.once("close", (code) => {
        resolve(code);
      });
    });
    expect(closeCode).toBe(4401);
    expect(repo.list()).toHaveLength(0);
    await conn.close();
  });
});
