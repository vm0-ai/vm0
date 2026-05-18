import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { parse, type UrlWithParsedQuery } from "node:url";
import { http as mswHttp, passthrough } from "msw";
import { describe, expect, it } from "vitest";
import { matchesApiBackendRewritePath } from "../api-backend-rewrites";
import { server } from "../src/mocks/server";

type ProxyRequest = (
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: UrlWithParsedQuery,
  upgradeHead: Buffer | undefined,
  reqBody: Buffer | undefined,
  proxyTimeout: number | null,
) => Promise<void>;

interface EchoPayload {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | readonly string[] | undefined>;
  readonly body: string;
}

const require = createRequire(import.meta.url);
const { proxyRequest } =
  require("next/dist/server/lib/router-utils/proxy-request.js") as {
    readonly proxyRequest: ProxyRequest;
  };
const AGENT_COMPOSE_ID = "550e8400-e29b-41d4-a716-446655440000";
const AGENT_RUN_ID = "550e8400-e29b-41d4-a716-446655440000";
const VOICE_CHAT_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function endWithError(response: ServerResponse, error: unknown): void {
  if (!response.headersSent) {
    response.statusCode = 500;
  }
  response.end(String(error));
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected TCP server address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function withRewriteProxy<T>(
  handler: (request: IncomingMessage) => Promise<Response>,
  test: (origin: string) => Promise<T>,
): Promise<T> {
  const backend = createServer((request, response) => {
    void (async () => {
      const result = await handler(request);
      response.statusCode = result.status;
      result.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "set-cookie") {
          response.setHeader(key, value);
        }
      });
      for (const cookie of result.headers.getSetCookie()) {
        response.appendHeader("set-cookie", cookie);
      }
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch((error: unknown) => {
      endWithError(response, error);
    });
  });

  const backendPort = await listen(backend);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const proxy = createServer((request, response) => {
    const target = parse(`${backendOrigin}${request.url ?? "/"}`, true);
    proxyRequest(request, response, target, undefined, undefined, null).catch(
      (error: unknown) => {
        endWithError(response, error);
      },
    );
  });

  const proxyPort = await listen(proxy);
  const proxyOrigin = `http://127.0.0.1:${proxyPort}`;
  server.use(
    mswHttp.all(`${backendOrigin}/*`, () => {
      return passthrough();
    }),
    mswHttp.all(`${proxyOrigin}/*`, () => {
      return passthrough();
    }),
  );
  try {
    return await test(proxyOrigin);
  } finally {
    await close(proxy);
    await close(backend);
  }
}

describe("API backend rewrite proxy behavior", () => {
  it("matches only one segment for agent checkpoint rewrites", () => {
    expect(
      matchesApiBackendRewritePath("/api/agent/checkpoints/checkpoint_123"),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/agent/checkpoints")).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/agent/checkpoints/checkpoint_123/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/agent/checkpoint/checkpoint_123"),
    ).toBe(false);
  });

  it("matches the auth me rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/auth/me")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/auth/me/extra")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/auth")).toBe(false);
  });

  it("matches the CLI auth device rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cli/auth/device")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/cli/auth/device/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/cli/auth")).toBe(false);
  });

  it("matches the CLI auth org rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cli/auth/org")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/cli/auth/org/extra")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/cli/auth")).toBe(false);
  });

  it("matches the CLI auth token rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cli/auth/token")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/cli/auth/token/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/cli/auth")).toBe(false);
  });

  it("matches the CLI auth test approve rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cli/auth/test-approve")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/cli/auth/test-approve/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/cli/auth")).toBe(false);
  });

  it("matches the CLI auth test Codex OAuth rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cli/auth/test-codex-oauth")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/cli/auth/test-codex-oauth/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/cli/auth")).toBe(false);
  });

  it("matches the CLI auth test connector rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cli/auth/test-connector")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/cli/auth/test-connector/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/cli/auth")).toBe(false);
  });

  it("matches the CLI auth test enable connector rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/cli/auth/test-enable-connector"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/cli/auth/test-enable-connector/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/cli/auth")).toBe(false);
  });

  it("matches the CLI auth test token rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cli/auth/test-token")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/cli/auth/test-token/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/cli/auth")).toBe(false);
  });

  it("matches only one segment for agent session by-id rewrites", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/agent/sessions/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/agent/sessions")).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/agent/sessions/550e8400-e29b-41d4-a716-446655440000/extra",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/agent/session/abc")).toBe(false);
  });

  it("matches the agent runs queue rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/agent/runs/queue")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/agent/runs/queue/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/agent/runs")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/agent/runs/queues")).toBe(false);
  });

  it("matches the agent composes collection rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/agent/composes")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/agent/composes/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/agent/compose")).toBe(false);
  });

  it("matches the agent composes versions rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/agent/composes/versions")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/agent/composes/versions/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/agent/composes/version")).toBe(
      false,
    );
  });

  it("matches the agent composes list rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/agent/composes/list")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/agent/composes/list/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/agent/composes/lists")).toBe(
      false,
    );
  });

  it("matches only UUID-shaped agent compose by-id paths", () => {
    expect(
      matchesApiBackendRewritePath(`/api/agent/composes/${AGENT_COMPOSE_ID}`),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/agent/composes/not-a-uuid")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/composes/${AGENT_COMPOSE_ID}/extra`,
      ),
    ).toBe(false);
  });

  it("keeps agent compose sibling rewrites explicitly matched", () => {
    expect(matchesApiBackendRewritePath("/api/agent/composes")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/agent/composes/list")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/agent/composes/versions")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/composes/${AGENT_COMPOSE_ID}/metadata`,
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/composes/${AGENT_COMPOSE_ID}/instructions`,
      ),
    ).toBe(true);
  });

  it("matches only UUID-shaped agent composes metadata paths", () => {
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/composes/${AGENT_COMPOSE_ID}/metadata`,
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/agent/composes/not-a-uuid/metadata"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/agent/composes/list/metadata"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/agent/composes/versions/metadata"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/composes/${AGENT_COMPOSE_ID}/metadata/extra`,
      ),
    ).toBe(false);
  });

  it("matches only UUID-shaped agent composes instructions paths", () => {
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/composes/${AGENT_COMPOSE_ID}/instructions`,
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/agent/composes/not-a-uuid/instructions",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/agent/composes/list/instructions"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/agent/composes/versions/instructions"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/composes/${AGENT_COMPOSE_ID}/instructions/extra`,
      ),
    ).toBe(false);
  });

  it("matches only UUID-shaped agent run cancel paths", () => {
    expect(
      matchesApiBackendRewritePath(`/api/agent/runs/${AGENT_RUN_ID}/cancel`),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/agent/runs/queue/cancel")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/agent/runs/not-a-uuid/cancel"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(`/api/agent/runs/${AGENT_RUN_ID}/events`),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/runs/${AGENT_RUN_ID}/cancel/extra`,
      ),
    ).toBe(false);
  });

  it("routes hosted-site deployment endpoints to the API backend", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/host/deployments/prepare"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/host/deployments/eca12aa0-4c26-48c7-85d8-b3af58d408c7/complete",
      ),
    ).toBe(true);
  });

  it("matches the email unsubscribe rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/email/unsubscribe")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/email/unsubscribe/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/email")).toBe(false);
  });

  it("matches the generate image rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/generate-image")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/generate-image/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/generate")).toBe(false);
  });

  it("matches the GitHub OAuth callback rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/github/oauth/callback")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/github/oauth/callback/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/github/oauth/callbacks")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/github/oauth")).toBe(false);
  });

  it("matches the GitHub OAuth install rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/github/oauth/install")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/github/oauth/install/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/github/oauth")).toBe(false);
  });

  it("matches the logs search rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/logs/search")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/logs/search/extra")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/logs")).toBe(false);
  });

  it("matches the GitHub integration rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/integrations/github")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/integrations/github/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/integrations")).toBe(false);
  });

  it("matches the storages commit rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/storages/commit")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/storages/commit/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/storages")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/storages/commits")).toBe(false);
  });

  it("matches the storages download rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/storages/download")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/storages/download/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/storages")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/storages/downloads")).toBe(false);
  });

  it("matches the storages list rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/storages/list")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/storages/list/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/storages")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/storages/lists")).toBe(false);
  });

  it("matches the storages prepare rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/storages/prepare")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/storages/prepare/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/storages")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/storages/prepared")).toBe(false);
  });

  it("matches the usage rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/usage")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/usage/extra")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/usages")).toBe(false);
  });

  it("matches the internal event consumer axiom rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/internal/event-consumers/axiom"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/internal/event-consumers/axiom/extra"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/internal/event-consumers/axioms"),
    ).toBe(false);
  });

  it("matches built-in generation webhook rewrites", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/webhooks/built-in-generations/fal/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/webhooks/built-in-generations/fal/550e8400-e29b-41d4-a716-446655440000/extra",
      ),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/webhooks")).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/webhooks/built-in-generation"),
    ).toBe(false);
  });

  it("matches the internal event consumer chat assistant rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/internal/event-consumers/chat-assistant",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/internal/event-consumers/chat-assistant/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/internal/event-consumers/chat-assistants",
      ),
    ).toBe(false);
  });

  it("matches the internal event consumer telegram typing rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/internal/event-consumers/telegram-typing",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/internal/event-consumers/telegram-typing/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/internal/event-consumers/telegram-typings",
      ),
    ).toBe(false);
  });

  it("matches the internal event consumer voice chat rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/internal/event-consumers/voice-chat"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/internal/event-consumers/voice-chat/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/internal/event-consumers/voice-chats"),
    ).toBe(false);
  });

  it("matches the zero voice-io quota, speech, stt, and tts rewrites exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/voice-io/quota")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/voice-io/quota/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/voice-io/speech")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/voice-io/speech/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/voice-io/stt")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/voice-io/stt/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/voice-io/tts")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/voice-io/tts/extra")).toBe(
      false,
    );
  });

  it("matches the usage insight rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/usage/insight")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/usage/insight/extra")).toBe(
      false,
    );
  });

  it("matches the usage members rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/usage/members")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/usage/members/extra")).toBe(
      false,
    );
  });

  it("matches the usage runs rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/usage/runs")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/usage/runs/extra")).toBe(
      false,
    );
  });

  it("matches the zero chat search rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/chat/search")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/chat/search/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/chat/searches")).toBe(false);
  });

  it("matches the zero chat thread detail rewrite path with one dynamic segment", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/extra",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/chat-threads")).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-thread/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(false);
  });

  it("matches the zero chat thread artifacts rewrite path with one dynamic segment", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/artifacts",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/artifacts/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-thread/550e8400-e29b-41d4-a716-446655440000/artifacts",
      ),
    ).toBe(false);
  });

  it("matches the zero chat thread mark-read rewrite path with one dynamic segment", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/mark-read",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/mark-read/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-thread/550e8400-e29b-41d4-a716-446655440000/mark-read",
      ),
    ).toBe(false);
  });

  it("matches the zero chat thread pin rewrite path with one dynamic segment", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/pin",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/pin/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-thread/550e8400-e29b-41d4-a716-446655440000/pin",
      ),
    ).toBe(false);
  });

  it("matches the zero chat thread rename rewrite path with one dynamic segment", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/rename",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/rename/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-thread/550e8400-e29b-41d4-a716-446655440000/rename",
      ),
    ).toBe(false);
  });

  it("matches the zero chat thread unpin rewrite path with one dynamic segment", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/unpin",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/unpin/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-thread/550e8400-e29b-41d4-a716-446655440000/unpin",
      ),
    ).toBe(false);
  });

  it("matches the push subscriptions rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/push-subscriptions")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/push-subscriptions/extra"),
    ).toBe(false);
  });

  it("matches the queue position rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/queue-position")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/queue-position/extra")).toBe(
      false,
    );
  });

  it("matches the zero skills collection rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/skills")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/skills/extra/path")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/skill")).toBe(false);
  });

  it("matches the zero skills by-name rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/skills/my-skill")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/skills/my-skill/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/skill/my-skill")).toBe(
      false,
    );
  });

  it("matches the zero agents collection rewrite path", () => {
    expect(matchesApiBackendRewritePath("/api/zero/agents")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/agent")).toBe(false);
  });

  it("matches only one segment for zero agent by-id rewrites", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/agent/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(false);
  });

  it("matches only one segment for zero agent custom connector rewrites", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000/custom-connectors",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000/custom-connectors/extra",
      ),
    ).toBe(false);
  });

  it("matches only one segment for zero agent user connector rewrites", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000/user-connectors",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000/user-connectors/extra",
      ),
    ).toBe(false);
  });

  it("matches only one segment for zero agent instructions rewrites", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000/instructions",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000/instructions/extra",
      ),
    ).toBe(false);
  });

  it("matches the zero team rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/team")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/team/extra")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/teams")).toBe(false);
  });

  it("matches the permission access requests rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/permission-access-requests"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/permission-access-requests/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/permission-access-request"),
    ).toBe(false);
  });

  it("matches the zero secrets root rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/secrets")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/secret")).toBe(false);
  });

  it("matches the zero model policies rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/model-policies")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/model-policies/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/model-policy")).toBe(false);
  });

  it("matches the zero realtime token rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/realtime/token")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/realtime/token/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/realtime")).toBe(false);
  });

  it("matches the report error rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/report-error")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/report-error/extra")).toBe(
      false,
    );
  });

  it("matches the zero secrets by-name rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/secrets/DELETE_ME")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/secrets/DELETE_ME/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/secret/DELETE_ME")).toBe(
      false,
    );
  });

  it("matches the permission policies rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/permission-policies")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/permission-policies/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/permission-policy")).toBe(
      false,
    );
  });

  it("matches the user model preference rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/user-model-preference"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/user-model-preference/extra"),
    ).toBe(false);
  });

  it("matches the zero org list rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/org/list")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/org/list/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/org/lists")).toBe(false);
  });

  it("matches the zero org rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/org")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/org/extra")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/orgs")).toBe(false);
  });

  it("matches the zero org domains rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/org/domains")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/org/domains/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/org/domain")).toBe(false);
  });

  it("matches the zero me model-providers root rewrite exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/me/model-providers")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/me/model-providers/claude-code-oauth-token/oauth/authorize",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/me/model-provider")).toBe(
      false,
    );
  });

  it("matches only one segment for zero me model-provider type rewrites", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/me/model-providers/claude-code-oauth-token",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/me/model-providers/claude-code-oauth-token/oauth/authorize",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/me/model-providers/codex-oauth-token/oauth/authorize/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/me/model-providers/claude-code-oauth-token/extra",
      ),
    ).toBe(false);
  });

  it("matches the zero model providers rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/model-providers")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/model-providers-extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/model-provider")).toBe(
      false,
    );
  });

  it("matches the zero member credit cap rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/org/members/credit-cap"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/org/members/credit-cap/extra"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/org/members/credit-caps"),
    ).toBe(false);
  });

  it("matches the zero org members rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/org/members")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/org/members/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/org/member")).toBe(false);
  });

  it("matches the zero org delete rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/org/delete")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/org/delete/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/org/deleted")).toBe(false);
  });

  it("matches the zero variables rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/variables")).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/variables/extra/nested"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/variable")).toBe(false);
  });

  it("matches only one segment for zero variable by-name rewrites", () => {
    expect(matchesApiBackendRewritePath("/api/zero/variables/USER_TOKEN")).toBe(
      true,
    );
    expect(matchesApiBackendRewritePath("/api/zero/variables")).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/variables/USER_TOKEN/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/variable/USER_TOKEN")).toBe(
      false,
    );
  });

  it("matches the zero onboarding status rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/onboarding/status")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/onboarding/status/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/onboarding")).toBe(false);
  });

  it("matches the zero onboarding setup rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/onboarding/setup")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/onboarding/setup/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/onboarding")).toBe(false);
  });

  it("matches the zero org membership requests rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/org/membership-requests"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/org/membership-requests/extra"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/org/membership-request"),
    ).toBe(false);
  });

  it("matches the zero org invite rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/org/invite")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/org/invite/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/org/invites")).toBe(false);
  });

  it("matches the zero org leave rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/org/leave")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/org/leave/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/org/leaves")).toBe(false);
  });

  it("matches the zero model provider type rewrite path by one segment", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/model-providers/anthropic-api-key",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/model-providers/codex-oauth-token",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/model-providers/anthropic-api-key/extra",
      ),
    ).toBe(false);
  });

  it("matches the zero org logo rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/org/logo")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/org/logo/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/org/logos")).toBe(false);
  });

  it("matches the zero voice-chat token rewrite exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/voice-chat/token")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/voice-chat/token/extra"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/voice-chat/token/items"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/voice-chat/token/tasks"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/voice-chat/token/trigger-reasoning",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/voice-chat/not-a-uuid"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/voice-chat/not-a-uuid/items"),
    ).toBe(false);
  });

  it("matches the zero uploads complete rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/uploads/complete")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/uploads/complete/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/uploads/other")).toBe(false);
  });

  it("matches only UUID-shaped zero voice-chat task rewrites", () => {
    expect(
      matchesApiBackendRewritePath(
        `/api/zero/voice-chat/${VOICE_CHAT_SESSION_ID}/tasks`,
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/voice-chat/token/tasks"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/voice-chat/not-a-uuid/tasks"),
    ).toBe(false);
  });

  it("forwards method, query, cookies, and request body", async () => {
    await withRewriteProxy(
      async (request) => {
        return Response.json({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: await readRequestBody(request),
        });
      },
      async (origin) => {
        const response = await fetch(
          `${origin}/api/device-token?from=web-rewrite`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: "session=opaque",
            },
            body: JSON.stringify({ device_type: "bb0" }),
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe("/api/device-token?from=web-rewrite");
        expect(payload.headers.cookie).toBe("session=opaque");
        expect(payload.headers["x-forwarded-host"]).toContain("127.0.0.1:");
        expect(payload.body).toBe(JSON.stringify({ device_type: "bb0" }));
      },
    );
  });

  it("preserves OAuth redirects and multiple Set-Cookie headers", async () => {
    await withRewriteProxy(
      async () => {
        return new Response(null, {
          status: 307,
          headers: [
            ["location", "https://auth.example.test/oauth?state=abc"],
            [
              "set-cookie",
              "model_provider_oauth_state=abc; Max-Age=900; Path=/; HttpOnly",
            ],
            [
              "set-cookie",
              "model_provider_oauth_pkce=verifier; Max-Age=900; Path=/; HttpOnly",
            ],
          ],
        });
      },
      async (origin) => {
        const response = await fetch(
          `${origin}/api/zero/me/model-providers/codex-oauth-token/oauth/authorize?from=settings`,
          { redirect: "manual" },
        );

        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe(
          "https://auth.example.test/oauth?state=abc",
        );
        expect(response.headers.getSetCookie()).toStrictEqual([
          "model_provider_oauth_state=abc; Max-Age=900; Path=/; HttpOnly",
          "model_provider_oauth_pkce=verifier; Max-Age=900; Path=/; HttpOnly",
        ]);
      },
    );
  });
});
