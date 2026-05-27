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
import {
  matchesApiBackendRewritePath,
  matchesGithubOAuthRewritePath,
} from "../api-backend-rewrites";
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
const ZERO_RUN_ID = "550e8400-e29b-41d4-a716-446655440000";
const ZERO_LOG_ID = "550e8400-e29b-41d4-a716-446655440000";
const ZERO_CONNECTOR_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

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

  it("matches the CLI auth approve rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cli/auth/approve")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/cli/auth/approve/extra")).toBe(
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

  it("matches the test OAuth provider authorize rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/test/oauth-provider/authorize"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/test/oauth-provider/authorize/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/test/oauth-provider")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/test/oauth-provider/profile"),
    ).toBe(false);
  });

  it("matches the test OAuth provider device code rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/test/oauth-provider/device/code"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/test/oauth-provider/device/code/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/test/oauth-provider/device"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/test/oauth-provider")).toBe(
      false,
    );
  });

  it("matches the test OAuth provider echo rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/test/oauth-provider/echo")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/test/oauth-provider/echo/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/test/oauth-provider")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/test/oauth-provider/profile"),
    ).toBe(false);
  });

  it("matches the test OAuth provider token rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/test/oauth-provider/token")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/test/oauth-provider/token/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/test/oauth-provider")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/test/oauth-provider/profile"),
    ).toBe(false);
  });

  it("matches the test OAuth provider userinfo rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/test/oauth-provider/userinfo"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/test/oauth-provider/userinfo/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/test/oauth-provider")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/test/oauth-provider/profile"),
    ).toBe(false);
  });

  it("matches the test Slack auth mock rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/test/slack-mock/auth.test")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/auth.test/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/test/slack-mock/auth")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/auth.tests"),
    ).toBe(false);
  });

  it("matches the test Slack chat.postMessage mock rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/chat.postMessage"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/test/slack-mock/chat.postMessage/extra",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/test/slack-mock/chat.post")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/chat.postMessages"),
    ).toBe(false);
  });

  it("matches the test Slack conversations.history mock rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/test/slack-mock/conversations.history",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/test/slack-mock/conversations.history/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/conversations"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/test/slack-mock/conversations.historys",
      ),
    ).toBe(false);
  });

  it("matches the test Slack conversations.replies mock rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/test/slack-mock/conversations.replies",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/test/slack-mock/conversations.replies/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/conversations"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/test/slack-mock/conversations.repliess",
      ),
    ).toBe(false);
  });

  it("matches the test Slack users.info mock rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/users.info"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/users.info/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/test/slack-mock/users")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/users.infos"),
    ).toBe(false);
  });

  it("matches one bot token and one method for the test Telegram mock rewrite", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/test/telegram-mock/bot123/sendMessage",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/test/telegram-mock/bot123/sendMessage/extra",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/test/telegram-mock/bot123")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/test/telegram-mock")).toBe(false);
  });

  it("matches the cron aggregate insights rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cron/aggregate-insights")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/cron/aggregate-insights/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/cron")).toBe(false);
  });

  it("matches the cron aggregate usage rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cron/aggregate-usage")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/cron/aggregate-usage/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/cron")).toBe(false);
  });

  it("matches the cron cleanup sandboxes rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cron/cleanup-sandboxes")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/cron/cleanup-sandboxes/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/cron")).toBe(false);
  });

  it("matches the cron drain email outbox rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cron/drain-email-outbox")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/cron/drain-email-outbox/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/cron")).toBe(false);
  });

  it("matches the cron execute schedules rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cron/execute-schedules")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/cron/execute-schedules/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/cron")).toBe(false);
  });

  it("matches the cron process usage events rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cron/process-usage-events")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/cron/process-usage-events/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/cron")).toBe(false);
  });

  it("matches the cron reconcile billing entitlements rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/cron/reconcile-billing-entitlements"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/cron/reconcile-billing-entitlements/extra",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/cron")).toBe(false);
  });

  it("matches the zero insights range rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/insights/range")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/insights/range/extra")).toBe(
      false,
    );
  });

  it("matches the zero insights rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/insights")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/insights/extra")).toBe(
      false,
    );
  });

  it("matches the v1 chat thread send rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/v1/chat-threads/messages")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/v1/chat-threads/messages/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/v1/chat-threads")).toBe(false);
  });

  it("matches the v1 chat thread detail rewrite without shadowing sibling routes", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/v1/chat-threads/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/v1/chat-threads/not-a-uuid"),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/v1/chat-threads/messages")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath(
        "/api/v1/chat-threads/550e8400-e29b-41d4-a716-446655440000/messages",
      ),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/v1/chat-threads")).toBe(false);
  });

  it("matches the v1 chat thread messages rewrite without shadowing sibling routes", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/v1/chat-threads/550e8400-e29b-41d4-a716-446655440000/messages",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/v1/chat-threads/not-a-uuid/messages"),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/v1/chat-threads/messages")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath(
        "/api/v1/chat-threads/550e8400-e29b-41d4-a716-446655440000/messages/extra",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/v1/chat-threads")).toBe(false);
  });

  it("matches the cron sync skills rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cron/sync-skills")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/cron/sync-skills/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/cron")).toBe(false);
  });

  it("matches the cron telegram cleanup rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/cron/telegram-cleanup")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/cron/telegram-cleanup/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/cron")).toBe(false);
  });

  it("matches the internal agent callback rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/internal/callbacks/agent")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/internal/callbacks/agent/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/internal/callbacks")).toBe(false);
  });

  it("matches the internal chat callback rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/internal/callbacks/chat")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/internal/callbacks/chat/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/internal/callbacks")).toBe(false);
  });

  it("matches the internal GitHub issues callback rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/internal/callbacks/github/issues"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/internal/callbacks/github/issues/extra",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/internal/callbacks/github")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/internal/callbacks")).toBe(false);
  });

  it("matches the internal cron schedule callback rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/internal/callbacks/schedule/cron"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/internal/callbacks/schedule/cron/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/internal/callbacks/schedule"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/internal/callbacks")).toBe(false);
  });

  it("matches the internal loop schedule callback rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/internal/callbacks/schedule/loop"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/internal/callbacks/schedule/loop/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/internal/callbacks/schedule"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/internal/callbacks")).toBe(false);
  });

  it("matches the internal Slack org callback rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/internal/callbacks/slack/org"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/internal/callbacks/slack/org/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/internal/callbacks/slack")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/internal/callbacks")).toBe(false);
  });

  it("matches the internal Telegram callback rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/internal/callbacks/telegram"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/internal/callbacks/telegram/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/internal/callbacks")).toBe(false);
  });

  it("matches the connector authorize rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/connectors/github/authorize"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/connectors/github/authorize/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/connectors/authorize")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/connectors/github/authorizes"),
    ).toBe(false);
  });

  it("matches the connector callback rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/connectors/github/callback"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/connectors/github/callback/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/connectors/callback")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/connectors/github/callbacks"),
    ).toBe(false);
  });

  it("matches the zero connector authorize rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/github/authorize"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/connectors/github/authorize/extra",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/connectors/authorize")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/github/callback"),
    ).toBe(false);
  });

  it("matches the zero connectors list rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/connectors")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/connectors/")).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/github/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/connectors/search")).toBe(
      true,
    );
  });

  it("matches the zero connectors search rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/connectors/search")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/search/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/connectors/github")).toBe(
      true,
    );
  });

  it("matches the zero connector by-type rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/connectors/github")).toBe(
      true,
    );
    expect(matchesApiBackendRewritePath("/api/zero/connectors/atlassian")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/github/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/connector/github")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/connectors/search")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/local-agent"),
    ).toBe(true);
  });

  it("matches the zero connector API-token rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/github/api-token"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/connectors/github/api-token/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/connector/github/api-token"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/github/api"),
    ).toBe(false);
  });

  it("matches the zero connectors scope diff rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/github/scope-diff"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/connectors/github/scope-diff/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/scope-diff"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/github/scope"),
    ).toBe(false);
  });

  it("matches the zero integrations chat message rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/chat/message"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/chat/message/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/integrations/chat")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram"),
    ).toBe(false);
  });

  it("matches the zero integrations Slack message rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/message"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/slack/message/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/messages"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram"),
    ).toBe(false);
  });

  it("matches the zero integrations Slack status rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/integrations/slack")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/integrations/slacks")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram"),
    ).toBe(false);
  });

  it("matches the zero integrations Slack connect rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/connect"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/slack/connect/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/connects"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/connected"),
    ).toBe(false);
  });

  it("matches the zero connector sessions rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/github/sessions"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/connectors/github/sessions/not-a-uuid",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/connectors/sessions")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/github/session"),
    ).toBe(false);
  });

  it("matches the zero connector session polling rewrite path only for UUID session IDs", () => {
    expect(
      matchesApiBackendRewritePath(
        `/api/zero/connectors/github/sessions/${ZERO_CONNECTOR_SESSION_ID}`,
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/connectors/github/sessions/not-a-uuid",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/zero/connectors/github/sessions/${ZERO_CONNECTOR_SESSION_ID}/extra`,
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/zero/connectors/sessions/${ZERO_CONNECTOR_SESSION_ID}`,
      ),
    ).toBe(false);
  });

  it("matches the zero integrations Telegram bots rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram/bots"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/bots/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram/bot"),
    ).toBe(false);
  });

  it("matches the zero integrations Telegram download-file rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/download-file",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/download-file/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram/download"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram"),
    ).toBe(false);
  });

  it("matches the zero integrations Slack download-file rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/slack/download-file",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/slack/download-file/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/download"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/downloaded"),
    ).toBe(false);
  });

  it("matches the zero integrations Slack upload complete rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/slack/upload-file/complete",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/slack/upload-file/complete/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/upload-file"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/slack/upload-file/completed",
      ),
    ).toBe(false);
  });

  it("matches the zero integrations Slack upload init rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/slack/upload-file/init",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/slack/upload-file/init/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/upload-file"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/slack/upload-file/initialized",
      ),
    ).toBe(false);
  });

  it("matches the zero integrations Telegram message rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram/message"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/message/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/integrations/slacks")).toBe(
      false,
    );
  });

  it("matches the zero integrations Telegram upload init rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/upload-file/init",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/upload-file/init/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/upload-file",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram"),
    ).toBe(false);
  });

  it("matches the zero integrations Telegram upload complete rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/upload-file/complete",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/upload-file/complete/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/upload-file",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram"),
    ).toBe(false);
  });

  it("matches the zero connector OAuth start rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/github/oauth/start"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/connectors/github/oauth/start/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/oauth/start"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/connectors/github/oauth"),
    ).toBe(false);
  });

  it("matches Slack OAuth rewrite paths exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/slack/oauth/install")).toBe(
      true,
    );
    expect(matchesApiBackendRewritePath("/api/zero/slack/oauth/connect")).toBe(
      true,
    );
    expect(matchesApiBackendRewritePath("/api/zero/slack/oauth/callback")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/slack/oauth/install/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/slack/oauth")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/slack/oauth/events")).toBe(
      false,
    );
  });

  it("matches the Slack channels rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/slack/channels")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/slack/channels/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/slack/channel")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/slack/channels-list")).toBe(
      false,
    );
  });

  it("matches the Slack browser connect rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/slack/connect")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/slack/connect/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/slack/connection")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/slack/connect/oauth")).toBe(
      false,
    );
  });

  it("matches Slack provider callback rewrite paths exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/slack/events")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/slack/commands")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/slack/interactive")).toBe(
      true,
    );
    expect(matchesApiBackendRewritePath("/api/zero/slack/events/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/slack/commands/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/slack/command")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/slack/interactions")).toBe(
      false,
    );
  });

  it("matches Telegram callback rewrite paths exactly", () => {
    expect(matchesApiBackendRewritePath("/api/integrations/telegram")).toBe(
      true,
    );
    expect(matchesApiBackendRewritePath("/api/telegram/register")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/telegram/setup-status")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath(
        "/api/telegram/webhook/123456789:telegram-bot-token",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/integrations/telegram/auth-callback"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/integrations/telegram/link"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/integrations/telegram/123456789"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/integrations/telegram/123456789/avatar",
      ),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/telegram/register/extra")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/telegram/setup-status/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/telegram/webhook")).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/telegram/webhook/123456789:telegram-bot-token/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/integrations/telegram/auth-callback/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/integrations/telegram/link/extra"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/integrations/telegram/123456789/avatar/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/integrations/telegram/123456789/avatars",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/integrations/telegram/123456789/link"),
    ).toBe(false);
  });

  it("matches AgentPhone connect and webhook rewrite paths exactly", () => {
    expect(matchesApiBackendRewritePath("/api/agentphone/connect")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/agentphone/webhook")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/agentphone/connect/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/agentphone/webhook/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/agentphone")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/agentphone/messages")).toBe(
      false,
    );
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
    expect(matchesApiBackendRewritePath("/api/agent/runs/queues")).toBe(false);
  });

  it("matches the agent runs collection rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/agent/runs")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/agent/runs/extra")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/agent/run")).toBe(false);
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
      matchesApiBackendRewritePath(
        `/api/agent/runs/${AGENT_RUN_ID}/cancel/extra`,
      ),
    ).toBe(false);
  });

  it("matches only UUID-shaped agent run events paths", () => {
    expect(
      matchesApiBackendRewritePath(`/api/agent/runs/${AGENT_RUN_ID}/events`),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/agent/runs/queue/events")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/agent/runs/not-a-uuid/events"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/runs/${AGENT_RUN_ID}/events/extra`,
      ),
    ).toBe(false);
  });

  it("matches only UUID-shaped agent run detail paths", () => {
    expect(
      matchesApiBackendRewritePath(`/api/agent/runs/${AGENT_RUN_ID}`),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/agent/runs/not-a-uuid")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath(`/api/agent/runs/${AGENT_RUN_ID}/extra`),
    ).toBe(false);
  });

  it("matches only UUID-shaped agent run telemetry paths", () => {
    expect(
      matchesApiBackendRewritePath(`/api/agent/runs/${AGENT_RUN_ID}/telemetry`),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/agent/runs/queue/telemetry"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/agent/runs/not-a-uuid/telemetry"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/runs/${AGENT_RUN_ID}/telemetry/extra`,
      ),
    ).toBe(false);
  });

  it("matches only UUID-shaped agent run agent telemetry paths", () => {
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/runs/${AGENT_RUN_ID}/telemetry/agent`,
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/agent/runs/not-a-uuid/telemetry/agent",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/runs/${AGENT_RUN_ID}/telemetry/agent/extra`,
      ),
    ).toBe(false);
  });

  it("matches only UUID-shaped agent run metrics telemetry paths", () => {
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/runs/${AGENT_RUN_ID}/telemetry/metrics`,
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/agent/runs/not-a-uuid/telemetry/metrics",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/runs/${AGENT_RUN_ID}/telemetry/metrics/extra`,
      ),
    ).toBe(false);
  });

  it("matches only UUID-shaped agent run network telemetry paths", () => {
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/runs/${AGENT_RUN_ID}/telemetry/network`,
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/agent/runs/not-a-uuid/telemetry/network",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/runs/${AGENT_RUN_ID}/telemetry/network/extra`,
      ),
    ).toBe(false);
  });

  it("matches only UUID-shaped agent run system log telemetry paths", () => {
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/runs/${AGENT_RUN_ID}/telemetry/system-log`,
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/agent/runs/not-a-uuid/telemetry/system-log",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/agent/runs/${AGENT_RUN_ID}/telemetry/system-log/extra`,
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

  it("matches the inbound email provider webhook rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/email/inbound")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/email/inbound/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/email")).toBe(false);
  });

  it("matches the email reply callback rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/email/callbacks/reply"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/email/callbacks/reply/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/email/callbacks")).toBe(
      false,
    );
  });

  it("matches the email trigger callback rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/email/callbacks/trigger"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/email/callbacks/trigger/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/email/callbacks")).toBe(
      false,
    );
  });

  it("matches the generate image rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/generate-image")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/generate-image/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/generate")).toBe(false);
  });

  it("matches the GitHub App setup callback rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/github/app/setup/callback")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/github/app/setup/callback/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/github/app/setup")).toBe(false);
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

  it("matches the zero GitHub OAuth connect rewrite paths exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/github/oauth/connect")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/github/oauth/connect/callback"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/github/oauth/connect/callback/extra",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/github/oauth")).toBe(false);
  });

  it("matches GitHub OAuth web-origin rewrite paths exactly", () => {
    expect(
      matchesGithubOAuthRewritePath("/api/github/app/setup/callback"),
    ).toBe(true);
    expect(matchesGithubOAuthRewritePath("/api/github/oauth/install")).toBe(
      true,
    );
    expect(
      matchesGithubOAuthRewritePath("/api/zero/github/oauth/connect"),
    ).toBe(true);
    expect(
      matchesGithubOAuthRewritePath("/api/zero/github/oauth/connect/callback"),
    ).toBe(true);
    expect(matchesGithubOAuthRewritePath("/api/integrations/github")).toBe(
      true,
    );
    expect(
      matchesGithubOAuthRewritePath("/api/github/app/setup/callback/extra"),
    ).toBe(false);
    expect(
      matchesGithubOAuthRewritePath("/api/integrations/github/extra"),
    ).toBe(false);
    expect(matchesGithubOAuthRewritePath("/api/zero/github/oauth")).toBe(false);
  });

  it("matches the logs search rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/logs/search")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/logs/search/extra")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/logs")).toBe(false);
  });

  it("matches the zero logs list rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/logs")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/logs/extra")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero")).toBe(false);
  });

  it("matches the zero logs by-id rewrite path only for UUID log IDs", () => {
    expect(matchesApiBackendRewritePath(`/api/zero/logs/${ZERO_LOG_ID}`)).toBe(
      true,
    );
    expect(matchesApiBackendRewritePath("/api/zero/logs/not-a-uuid")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath(`/api/zero/logs/${ZERO_LOG_ID}/extra`),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/logs/search")).toBe(true);
  });

  it("matches the zero logs search rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/logs/search")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/logs/search/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/logs/searches")).toBe(false);
  });

  it("matches the zero default-agent rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/default-agent")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/default-agent/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/default-agents")).toBe(
      false,
    );
  });

  it("matches the zero feature-switches rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/feature-switches")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/feature-switches/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/feature-switch")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/feature-switches-disabled"),
    ).toBe(false);
  });

  it("matches the GitHub integration rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/integrations/github")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/integrations/github/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/integrations")).toBe(false);
  });

  it("matches the GitHub webhook rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/webhooks/github")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/webhooks/github/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/webhooks")).toBe(false);
  });

  it("matches the agent checkpoint prepare-history webhook rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/webhooks/agent/checkpoints/prepare-history",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/webhooks/agent/checkpoints/prepare-history/extra",
      ),
    ).toBe(false);
  });

  it("matches the agent complete webhook rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/webhooks/agent/complete")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/complete/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/webhooks/agent")).toBe(false);
  });

  it("matches the agent events webhook rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/webhooks/agent/events")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/events/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/webhooks/agent")).toBe(false);
  });

  it("matches the agent firewall auth webhook rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/firewall/auth"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/firewall/auth/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/webhooks/agent/firewall")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/webhooks/agent")).toBe(false);
  });

  it("matches the agent heartbeat webhook rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/webhooks/agent/heartbeat")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/heartbeat/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/webhooks/agent")).toBe(false);
  });

  it("matches the agent telemetry webhook rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/webhooks/agent/telemetry")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/telemetry/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/webhooks/agent")).toBe(false);
  });

  it("matches the agent usage-event webhook rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/usage-event"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/usage-event/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/webhooks/agent")).toBe(false);
  });

  it("matches the agent storages commit webhook rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/storages/commit"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/storages/commit/extra"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/storages/commitment"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/webhooks/agent/storages")).toBe(
      false,
    );
  });

  it("matches the agent storages prepare webhook rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/storages/prepare"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/webhooks/agent/storages/prepare/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/storages/prepared"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/webhooks/agent/storages")).toBe(
      false,
    );
  });

  it("matches the agent checkpoints webhook rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/checkpoints"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/webhooks/agent/checkpoints/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/webhooks/agent")).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/webhooks/agent/checkpoints/prepare-history",
      ),
    ).toBe(true);
  });

  it("matches the Clerk webhook rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/webhooks/clerk")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/webhooks/clerk/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/webhooks")).toBe(false);
  });

  it("matches the Stripe webhook rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/webhooks/stripe")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/webhooks/stripe/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/webhooks")).toBe(false);
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

  it("matches the zero billing auto-recharge rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/billing/auto-recharge"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/billing/auto-recharge/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/billing")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/billing/status")).toBe(true);
  });

  it("matches the zero billing checkout rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/billing/checkout")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/billing/checkout/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/billing")).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/billing/checkout-session"),
    ).toBe(false);
  });

  it("matches the zero billing credit checkout rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/billing/credit-checkout"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/billing/credit-checkout/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/billing")).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/billing/credit-checkout-session"),
    ).toBe(false);
  });

  it("matches the zero billing downgrade rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/billing/downgrade")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/billing/downgrade/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/billing")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/billing/downgrades")).toBe(
      false,
    );
  });

  it("matches the zero billing invoices rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/billing/invoices")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/billing/invoices/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/billing")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/billing/invoice")).toBe(
      false,
    );
  });

  it("matches the zero billing portal rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/billing/portal")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/billing/portal/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/billing")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/billing/portals")).toBe(
      false,
    );
  });

  it("matches the zero billing redeem rewrite path by a single campaign segment", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/billing/redeem/ZERO100"),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/billing/redeem")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/billing/redeem/ZERO100/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/billing")).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/billing/redeems/ZERO100"),
    ).toBe(false);
  });

  it("matches the zero billing status rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/billing/status")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/billing/status/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/billing")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/billing/checkout")).toBe(
      true,
    );
  });

  it("matches the test slack dispatch probe rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/test/slack-dispatch-probe")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/test/slack-dispatch-probe/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/test/slack-dispatch")).toBe(
      false,
    );
  });

  it("matches the test slack mock assistant status rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/test/slack-mock/assistant.threads.setStatus",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/test/slack-mock/assistant.threads.setStatus/extra",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/test/slack-mock")).toBe(false);
  });

  it("matches the test slack mock chat.postEphemeral rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/chat.postEphemeral"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/test/slack-mock/chat.postEphemeral/extra",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/test/slack-mock")).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/chat.postEphemerals"),
    ).toBe(false);
  });

  it("matches the test slack mock conversations.open rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/conversations.open"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/test/slack-mock/conversations.open/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/conversations"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/conversations.opens"),
    ).toBe(false);
  });

  it("matches the test slack mock oauth.v2.access rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/oauth.v2.access"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/test/slack-mock/oauth.v2.access/extra",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/test/slack-mock/oauth.v2")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/oauth.v2.accesses"),
    ).toBe(false);
  });

  it("matches the test slack mock views.publish rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/views.publish"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/views.publish/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/test/slack-mock/views")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/test/slack-mock/views.published"),
    ).toBe(false);
  });

  it("matches the test slack state rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/test/slack-state")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/test/slack-state/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/test/slack-states")).toBe(false);
  });

  it("matches the test telegram state rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/test/telegram-state")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/test/telegram-state/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/test/telegram-states")).toBe(
      false,
    );
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

  it("matches the FAL built-in generation webhook rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/webhooks/built-in-generations/fal/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/webhooks/built-in-generations/fal/550e8400-e29b-41d4-a716-446655440000/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/webhooks/built-in-generations/fal/not-a-uuid",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/webhooks")).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/webhooks/built-in-generation"),
    ).toBe(false);
  });

  it("matches the BytePlus built-in generation webhook rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/webhooks/built-in-generations/byteplus/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/webhooks/built-in-generations/byteplus/550e8400-e29b-41d4-a716-446655440000/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/webhooks/built-in-generations/byteplus/not-a-uuid",
      ),
    ).toBe(false);
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

  it("matches the zero chat messages rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/chat/messages")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/chat/messages/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/chat/message")).toBe(false);
  });

  it("matches the zero composes rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/composes")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/compose")).toBe(false);
  });

  it("matches the zero composes list rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/composes/list")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/composes/list/extra")).toBe(
      false,
    );
  });

  it("matches the zero composes by-id rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/composes/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/composes/not-a-uuid")).toBe(
      true,
    );
    expect(matchesApiBackendRewritePath("/api/zero/composes/metadata")).toBe(
      true,
    );
    expect(matchesApiBackendRewritePath("/api/zero/composes/lists")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/composes/list/extra")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/composes/550e8400-e29b-41d4-a716-446655440000/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/compose/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(false);
  });

  it("matches the zero composes metadata rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/composes/550e8400-e29b-41d4-a716-446655440000/metadata",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/composes/not-a-uuid/metadata"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/composes/550e8400-e29b-41d4-a716-446655440000/metadata/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/compose/550e8400-e29b-41d4-a716-446655440000/metadata",
      ),
    ).toBe(false);
  });

  it("matches the zero computer-use host rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/computer-use/host")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/computer-use/host/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/computer-use")).toBe(false);
  });

  it("matches the zero computer-use register rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/computer-use/register"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/computer-use/register/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/computer-use")).toBe(false);
  });

  it("matches the zero computer-use unregister rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/computer-use/unregister"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/computer-use/unregister/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/computer-use")).toBe(false);
  });

  it("matches the zero computer-use host stop rewrite path exactly", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/computer-use/host/stop"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/computer-use/host/stop/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/computer-use/host")).toBe(
      true,
    );
  });

  it("matches the zero chat threads collection rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/chat-threads")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/chat-threads-extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/chat-thread")).toBe(false);
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

  it("matches the zero chat thread messages rewrite path with one dynamic segment", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/messages",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/messages/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/message",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/chat-thread/550e8400-e29b-41d4-a716-446655440000/messages",
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

  it("matches the zero image generation rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/image-io/generate")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/image-io/generate/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/image-io")).toBe(false);
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

  it("matches the zero maps rewrite subtree", () => {
    expect(matchesApiBackendRewritePath("/api/zero/maps/geocode")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/maps/places/search")).toBe(
      true,
    );
    expect(matchesApiBackendRewritePath("/api/zero/map/geocode")).toBe(false);
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

  it("matches the zero schedules disable rewrite path with one dynamic segment", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/schedules/nightly/disable"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/schedules/nightly/disable/extra"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/schedule/nightly/disable"),
    ).toBe(false);
  });

  it("matches the zero schedules collection rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/schedules")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/schedules/extra/path")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/schedule")).toBe(false);
  });

  it("matches the zero runs collection rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/runs")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/runs/not-a-uuid")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/run")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/runs/extra")).toBe(false);
  });

  it("matches the zero runs queue rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/runs/queue")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/runs/queue/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/runs/queues")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/run/queue")).toBe(false);
  });

  it("matches the zero runs by-id rewrite path only for UUID run IDs", () => {
    expect(matchesApiBackendRewritePath(`/api/zero/runs/${ZERO_RUN_ID}`)).toBe(
      true,
    );
    expect(matchesApiBackendRewritePath("/api/zero/runs/not-a-uuid")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath(`/api/zero/runs/${ZERO_RUN_ID}/extra`),
    ).toBe(false);
    expect(matchesApiBackendRewritePath(`/api/zero/run/${ZERO_RUN_ID}`)).toBe(
      false,
    );
  });

  it("matches the zero runs cancel rewrite path only for UUID run IDs", () => {
    expect(
      matchesApiBackendRewritePath(`/api/zero/runs/${ZERO_RUN_ID}/cancel`),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/runs/queue/cancel")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/runs/not-a-uuid/cancel"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/zero/runs/${ZERO_RUN_ID}/cancel/extra`,
      ),
    ).toBe(false);
  });

  it("matches the zero runs context rewrite path only for UUID run IDs", () => {
    expect(
      matchesApiBackendRewritePath(`/api/zero/runs/${ZERO_RUN_ID}/context`),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/runs/queue/context")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/runs/not-a-uuid/context"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/zero/runs/${ZERO_RUN_ID}/context/extra`,
      ),
    ).toBe(false);
  });

  it("matches the zero runs network rewrite path only for UUID run IDs", () => {
    expect(
      matchesApiBackendRewritePath(`/api/zero/runs/${ZERO_RUN_ID}/network`),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/runs/queue/network")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/runs/not-a-uuid/network"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/zero/runs/${ZERO_RUN_ID}/network/extra`,
      ),
    ).toBe(false);
  });

  it("matches the zero runs runner rewrite path only for UUID run IDs", () => {
    expect(
      matchesApiBackendRewritePath(`/api/zero/runs/${ZERO_RUN_ID}/runner`),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/runs/queue/runner")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/runs/not-a-uuid/runner"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/zero/runs/${ZERO_RUN_ID}/runner/extra`,
      ),
    ).toBe(false);
  });

  it("matches the zero runs agent events rewrite path only for UUID run IDs", () => {
    expect(
      matchesApiBackendRewritePath(
        `/api/zero/runs/${ZERO_RUN_ID}/telemetry/agent`,
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/runs/queue/telemetry/agent"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/runs/not-a-uuid/telemetry/agent"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(`/api/zero/runs/${ZERO_RUN_ID}/telemetry`),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        `/api/zero/runs/${ZERO_RUN_ID}/telemetry/agent/extra`,
      ),
    ).toBe(false);
  });

  it("matches the zero schedules run rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/schedules/run")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/schedules/run/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/zero/schedule/run")).toBe(false);
  });

  it("matches the zero schedules by-name rewrite path with one dynamic segment", () => {
    expect(matchesApiBackendRewritePath("/api/zero/schedules/nightly")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/schedules/nightly/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/schedule/nightly")).toBe(
      false,
    );
  });

  it("matches the zero schedules enable rewrite path with one dynamic segment", () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/schedules/nightly/enable"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/schedules/nightly/enable/extra"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/schedule/nightly/enable"),
    ).toBe(false);
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

  it("matches zero custom connectors root rewrites exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/custom-connectors")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/custom-connectors/550e8400-e29b-41d4-a716-446655440000/secret/extra",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/custom-connector")).toBe(
      false,
    );
  });

  it("matches only one segment for zero custom connector by-id rewrites", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/custom-connectors/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/custom-connectors/550e8400-e29b-41d4-a716-446655440000/extra",
      ),
    ).toBe(false);
  });

  it("matches zero custom connector secret rewrites exactly", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/custom-connectors/550e8400-e29b-41d4-a716-446655440000/secret",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/custom-connectors/550e8400-e29b-41d4-a716-446655440000/secret/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/custom-connector/550e8400-e29b-41d4-a716-446655440000/secret",
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

  it("matches the zero api keys collection rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/api-keys")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/api-key")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/api-keys/extra")).toBe(
      false,
    );
  });

  it("matches UUID-shaped zero api key detail rewrite paths", () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/api-keys/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/api-keys/not-a-uuid")).toBe(
      false,
    );
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/api-keys/550e8400-e29b-41d4-a716-446655440000/extra",
      ),
    ).toBe(false);
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

  it("matches the developer support rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/developer-support")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/developer-support/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/developer")).toBe(false);
  });

  it("matches the runners heartbeat rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/runners/heartbeat")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/runners/heartbeat/extra")).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/runners")).toBe(false);
  });

  it("matches the runners job claim rewrite path exactly", () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    expect(
      matchesApiBackendRewritePath(`/api/runners/jobs/${runId}/claim`),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(`/api/runners/jobs/${runId}/claim/extra`),
    ).toBe(false);
    expect(matchesApiBackendRewritePath(`/api/runners/jobs/${runId}`)).toBe(
      false,
    );
    expect(matchesApiBackendRewritePath("/api/runners/jobs")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/runners")).toBe(false);
  });

  it("matches the runners poll rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/runners/poll")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/runners/poll/extra")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/runners")).toBe(false);
  });

  it("matches the runners realtime token rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/runners/realtime/token")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/runners/realtime/token/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/runners/realtime")).toBe(false);
    expect(matchesApiBackendRewritePath("/api/runners")).toBe(false);
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
        "/api/zero/me/model-providers/codex-oauth-token/oauth/authorize",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/me/model-providers/codex-oauth-token/oauth/callback",
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

  it("matches the zero uploads complete rewrite path exactly", () => {
    expect(matchesApiBackendRewritePath("/api/zero/uploads/complete")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/uploads/complete/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/uploads/other")).toBe(false);
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

  it("forwards Slack provider callback POST bodies and signature headers", async () => {
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
        const callbackRequests = [
          {
            path: "/api/zero/slack/events",
            contentType: "application/json",
            body: JSON.stringify({
              type: "url_verification",
              challenge: "challenge-123",
            }),
          },
          {
            path: "/api/zero/slack/commands",
            contentType: "application/x-www-form-urlencoded",
            body: new URLSearchParams({
              command: "/zero",
              text: "help",
            }).toString(),
          },
          {
            path: "/api/zero/slack/interactive",
            contentType: "application/x-www-form-urlencoded",
            body: new URLSearchParams({
              payload: JSON.stringify({ type: "block_actions" }),
            }).toString(),
          },
        ] as const;

        for (const callbackRequest of callbackRequests) {
          const response = await fetch(
            `${origin}${callbackRequest.path}?from=slack`,
            {
              method: "POST",
              headers: {
                "content-type": callbackRequest.contentType,
                "x-slack-request-timestamp": "1710000000",
                "x-slack-signature": "v0=test-signature",
              },
              body: callbackRequest.body,
            },
          );

          const payload = (await response.json()) as EchoPayload;
          expect(payload.method).toBe("POST");
          expect(payload.url).toBe(`${callbackRequest.path}?from=slack`);
          expect(payload.headers["content-type"]).toContain(
            callbackRequest.contentType,
          );
          expect(payload.headers["x-slack-request-timestamp"]).toBe(
            "1710000000",
          );
          expect(payload.headers["x-slack-signature"]).toBe(
            "v0=test-signature",
          );
          expect(payload.body).toBe(callbackRequest.body);
        }
      },
    );
  });

  it("forwards Telegram callback requests and provider headers", async () => {
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
        const webhookBody = JSON.stringify({
          message: { text: "/start", chat: { id: 1234 } },
        });
        const webhookResponse = await fetch(
          `${origin}/api/telegram/webhook/123456789:telegram-bot-token?from=telegram`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-telegram-bot-api-secret-token": "telegram-secret",
            },
            body: webhookBody,
          },
        );

        const webhookPayload = (await webhookResponse.json()) as EchoPayload;
        expect(webhookPayload.method).toBe("POST");
        expect(webhookPayload.url).toBe(
          "/api/telegram/webhook/123456789:telegram-bot-token?from=telegram",
        );
        expect(webhookPayload.headers["content-type"]).toContain(
          "application/json",
        );
        expect(webhookPayload.headers["x-telegram-bot-api-secret-token"]).toBe(
          "telegram-secret",
        );
        expect(webhookPayload.body).toBe(webhookBody);

        const authResponse = await fetch(
          `${origin}/api/integrations/telegram/auth-callback?id=1001&hash=telegram-hash`,
        );

        const authPayload = (await authResponse.json()) as EchoPayload;
        expect(authPayload.method).toBe("GET");
        expect(authPayload.url).toBe(
          "/api/integrations/telegram/auth-callback?id=1001&hash=telegram-hash",
        );

        const listResponse = await fetch(`${origin}/api/integrations/telegram`);

        const listPayload = (await listResponse.json()) as EchoPayload;
        expect(listPayload.method).toBe("GET");
        expect(listPayload.url).toBe("/api/integrations/telegram");

        const linkBody = JSON.stringify({ telegramBotId: "official" });
        const linkResponse = await fetch(
          `${origin}/api/integrations/telegram/link?botId=official`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: linkBody,
          },
        );

        const linkPayload = (await linkResponse.json()) as EchoPayload;
        expect(linkPayload.method).toBe("POST");
        expect(linkPayload.url).toBe(
          "/api/integrations/telegram/link?botId=official",
        );
        expect(linkPayload.headers["content-type"]).toContain(
          "application/json",
        );
        expect(linkPayload.body).toBe(linkBody);

        const botBody = JSON.stringify({ defaultAgentId: "agent_123" });
        const botResponse = await fetch(
          `${origin}/api/integrations/telegram/123456789?view=detail`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: botBody,
          },
        );

        const botPayload = (await botResponse.json()) as EchoPayload;
        expect(botPayload.method).toBe("PATCH");
        expect(botPayload.url).toBe(
          "/api/integrations/telegram/123456789?view=detail",
        );
        expect(botPayload.headers["content-type"]).toContain(
          "application/json",
        );
        expect(botPayload.body).toBe(botBody);

        const avatarResponse = await fetch(
          `${origin}/api/integrations/telegram/123456789/avatar?exp=1000&sig=avatar-signature`,
        );

        const avatarPayload = (await avatarResponse.json()) as EchoPayload;
        expect(avatarPayload.method).toBe("GET");
        expect(avatarPayload.url).toBe(
          "/api/integrations/telegram/123456789/avatar?exp=1000&sig=avatar-signature",
        );
      },
    );
  });

  it("forwards AgentPhone webhook POST bodies and signature headers", async () => {
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
        const webhookBody = JSON.stringify({
          event: "agent.message",
          data: {
            messageId: "msg-agentphone-1",
            agentId: "agt-agentphone",
            from: "+15551234567",
            to: "+15557654321",
            body: "hello",
          },
        });
        const response = await fetch(
          `${origin}/api/agentphone/webhook?from=agentphone`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-webhook-id": "webhook-agentphone-1",
              "x-webhook-timestamp": "1710000000",
              "x-webhook-signature": "sha256=test-signature",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe("/api/agentphone/webhook?from=agentphone");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.headers["x-webhook-id"]).toBe("webhook-agentphone-1");
        expect(payload.headers["x-webhook-timestamp"]).toBe("1710000000");
        expect(payload.headers["x-webhook-signature"]).toBe(
          "sha256=test-signature",
        );
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards GitHub webhook POST bodies and signature headers", async () => {
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
        const webhookBody = JSON.stringify({
          zen: "Non-blocking webhook migrations",
        });
        const response = await fetch(
          `${origin}/api/webhooks/github?from=github`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-github-delivery": "delivery-github-1",
              "x-github-event": "ping",
              "x-hub-signature-256": "sha256=test-signature",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe("/api/webhooks/github?from=github");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.headers["x-github-delivery"]).toBe("delivery-github-1");
        expect(payload.headers["x-github-event"]).toBe("ping");
        expect(payload.headers["x-hub-signature-256"]).toBe(
          "sha256=test-signature",
        );
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards agent checkpoint prepare-history webhook POST bodies and sandbox auth", async () => {
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
        const webhookBody = JSON.stringify({
          runId: "run_prepare_history_1",
          hash: "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
          size: 1024,
        });
        const response = await fetch(
          `${origin}/api/webhooks/agent/checkpoints/prepare-history?from=prepare-history`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer sandbox-token",
              "content-type": "application/json",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe(
          "/api/webhooks/agent/checkpoints/prepare-history?from=prepare-history",
        );
        expect(payload.headers.authorization).toBe("Bearer sandbox-token");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards agent complete webhook POST bodies and sandbox auth", async () => {
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
        const webhookBody = JSON.stringify({
          runId: "run_complete_1",
          exitCode: 0,
          lastEventSequence: 12,
          sandboxId: "sandbox-complete-1",
          sandboxReuseResult: "reused",
        });
        const response = await fetch(
          `${origin}/api/webhooks/agent/complete?from=complete`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer sandbox-token",
              "content-type": "application/json",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe("/api/webhooks/agent/complete?from=complete");
        expect(payload.headers.authorization).toBe("Bearer sandbox-token");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards agent events webhook POST bodies and sandbox auth", async () => {
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
        const webhookBody = JSON.stringify({
          runId: "run_events_1",
          events: [
            {
              type: "tool_result",
              sequenceNumber: 12,
              data: { exitCode: 0 },
            },
          ],
        });
        const response = await fetch(
          `${origin}/api/webhooks/agent/events?from=events`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer sandbox-token",
              "content-type": "application/json",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe("/api/webhooks/agent/events?from=events");
        expect(payload.headers.authorization).toBe("Bearer sandbox-token");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards agent firewall auth webhook POST bodies and sandbox auth", async () => {
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
        const webhookBody = JSON.stringify({
          encryptedSecrets: "encrypted-secrets",
          authHeaders: {
            Authorization: "Bearer ${{ secrets.API_TOKEN }}",
          },
          authQuery: {
            token: "${{ secrets.API_TOKEN }}",
          },
          firewallBillable: true,
        });
        const response = await fetch(
          `${origin}/api/webhooks/agent/firewall/auth?from=firewall-auth`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer sandbox-token",
              "content-type": "application/json",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe(
          "/api/webhooks/agent/firewall/auth?from=firewall-auth",
        );
        expect(payload.headers.authorization).toBe("Bearer sandbox-token");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards agent heartbeat webhook POST bodies and sandbox auth", async () => {
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
        const webhookBody = JSON.stringify({ runId: "run_heartbeat_1" });
        const response = await fetch(
          `${origin}/api/webhooks/agent/heartbeat?from=heartbeat`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer sandbox-token",
              "content-type": "application/json",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe(
          "/api/webhooks/agent/heartbeat?from=heartbeat",
        );
        expect(payload.headers.authorization).toBe("Bearer sandbox-token");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards agent telemetry webhook POST bodies and sandbox auth", async () => {
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
        const webhookBody = JSON.stringify({
          runId: "run_telemetry_1",
          systemLog: "boot ok",
          metrics: [],
          networkLogs: [],
        });
        const response = await fetch(
          `${origin}/api/webhooks/agent/telemetry?from=telemetry`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer sandbox-token",
              "content-type": "application/json",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe(
          "/api/webhooks/agent/telemetry?from=telemetry",
        );
        expect(payload.headers.authorization).toBe("Bearer sandbox-token");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards agent usage-event webhook POST bodies and sandbox auth", async () => {
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
        const webhookBody = JSON.stringify({
          runId: "run_usage_event_1",
          events: [
            {
              idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
              kind: "connector",
              provider: "x",
              category: "tweet.read",
              quantity: 5,
            },
          ],
        });
        const response = await fetch(
          `${origin}/api/webhooks/agent/usage-event?from=usage-event`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer sandbox-token",
              "content-type": "application/json",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe(
          "/api/webhooks/agent/usage-event?from=usage-event",
        );
        expect(payload.headers.authorization).toBe("Bearer sandbox-token");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards agent storages commit webhook POST bodies and sandbox auth", async () => {
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
        const webhookBody = JSON.stringify({
          runId: "run_storage_commit_1",
          storageName: "artifact-storage",
          storageType: "artifact",
          versionId: "storage-version-1",
          files: [],
        });
        const response = await fetch(
          `${origin}/api/webhooks/agent/storages/commit?from=storage-commit`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer sandbox-token",
              "content-type": "application/json",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe(
          "/api/webhooks/agent/storages/commit?from=storage-commit",
        );
        expect(payload.headers.authorization).toBe("Bearer sandbox-token");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards agent storages prepare webhook POST bodies and sandbox auth", async () => {
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
        const webhookBody = JSON.stringify({
          runId: "run_storage_prepare_1",
          storageName: "artifact-storage",
          storageType: "artifact",
          files: [{ path: "test.txt", hash: "a".repeat(64), size: 100 }],
        });
        const response = await fetch(
          `${origin}/api/webhooks/agent/storages/prepare?from=storage-prepare`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer sandbox-token",
              "content-type": "application/json",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe(
          "/api/webhooks/agent/storages/prepare?from=storage-prepare",
        );
        expect(payload.headers.authorization).toBe("Bearer sandbox-token");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards agent checkpoints webhook POST bodies and sandbox auth", async () => {
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
        const webhookBody = JSON.stringify({
          runId: "run_checkpoint_1",
          cliAgentType: "codex",
          cliAgentSessionId: "session-run-checkpoint-1",
          cliAgentSessionHistoryHash:
            "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
        });
        const response = await fetch(
          `${origin}/api/webhooks/agent/checkpoints?from=checkpoints`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer sandbox-token",
              "content-type": "application/json",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe(
          "/api/webhooks/agent/checkpoints?from=checkpoints",
        );
        expect(payload.headers.authorization).toBe("Bearer sandbox-token");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards Clerk webhook POST bodies and Svix signature headers", async () => {
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
        const webhookBody = JSON.stringify({
          data: { id: "org_clerk_1" },
          type: "organization.deleted",
        });
        const response = await fetch(
          `${origin}/api/webhooks/clerk?from=clerk`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "svix-id": "msg_clerk_1",
              "svix-signature": "v1,test-signature",
              "svix-timestamp": "1710000000",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe("/api/webhooks/clerk?from=clerk");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.headers["svix-id"]).toBe("msg_clerk_1");
        expect(payload.headers["svix-signature"]).toBe("v1,test-signature");
        expect(payload.headers["svix-timestamp"]).toBe("1710000000");
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards inbound email webhook POST bodies and Svix signature headers", async () => {
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
        const webhookBody = JSON.stringify({
          type: "email.received",
          data: {
            email_id: "email_inbound_1",
            from: "sender@example.com",
            to: ["agent@mail.example.com"],
          },
        });
        const response = await fetch(
          `${origin}/api/zero/email/inbound?from=resend`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "svix-id": "msg_resend_1",
              "svix-signature": "v1,test-signature",
              "svix-timestamp": "1710000000",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe("/api/zero/email/inbound?from=resend");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.headers["svix-id"]).toBe("msg_resend_1");
        expect(payload.headers["svix-signature"]).toBe("v1,test-signature");
        expect(payload.headers["svix-timestamp"]).toBe("1710000000");
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards email reply callback POST bodies and VM0 signature headers", async () => {
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
        const callbackBody = JSON.stringify({
          callbackId: "callback_email_reply_1",
          runId: "run_email_reply_1",
          status: "completed",
          payload: {
            emailThreadSessionId: "thread_1",
            inboundEmailId: "email_inbound_1",
          },
        });
        const response = await fetch(
          `${origin}/api/zero/email/callbacks/reply?from=runner`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-vm0-signature": "sha256=test-signature",
              "x-vm0-timestamp": "1710000000",
            },
            body: callbackBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe("/api/zero/email/callbacks/reply?from=runner");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.headers["x-vm0-signature"]).toBe(
          "sha256=test-signature",
        );
        expect(payload.headers["x-vm0-timestamp"]).toBe("1710000000");
        expect(payload.body).toBe(callbackBody);
      },
    );
  });

  it("forwards email trigger callback POST bodies and VM0 signature headers", async () => {
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
        const callbackBody = JSON.stringify({
          callbackId: "callback_email_trigger_1",
          runId: "run_email_trigger_1",
          status: "completed",
          payload: {
            senderEmail: "sender@example.com",
            agentId: "agent_1",
            userId: "user_1",
            inboundEmailId: "email_inbound_1",
            replyToken: "reply_token_1",
          },
        });
        const response = await fetch(
          `${origin}/api/zero/email/callbacks/trigger?from=runner`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-vm0-signature": "sha256=test-signature",
              "x-vm0-timestamp": "1710000000",
            },
            body: callbackBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe(
          "/api/zero/email/callbacks/trigger?from=runner",
        );
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.headers["x-vm0-signature"]).toBe(
          "sha256=test-signature",
        );
        expect(payload.headers["x-vm0-timestamp"]).toBe("1710000000");
        expect(payload.body).toBe(callbackBody);
      },
    );
  });

  it("forwards Stripe webhook POST bodies and signature headers", async () => {
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
        const webhookBody = JSON.stringify({
          id: "evt_stripe_1",
          type: "invoice.paid",
        });
        const response = await fetch(
          `${origin}/api/webhooks/stripe?from=stripe`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "stripe-signature": "t=1710000000,v1=test-signature",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe("/api/webhooks/stripe?from=stripe");
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.headers["stripe-signature"]).toBe(
          "t=1710000000,v1=test-signature",
        );
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards FAL built-in generation webhook POST bodies", async () => {
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
        const generationId = "550e8400-e29b-41d4-a716-446655440000";
        const webhookBody = JSON.stringify({
          status: "COMPLETED",
          payload: {
            images: [{ url: "https://fal.media/files/test.webp" }],
          },
        });
        const response = await fetch(
          `${origin}/api/webhooks/built-in-generations/fal/${generationId}?token=test-token`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe(
          `/api/webhooks/built-in-generations/fal/${generationId}?token=test-token`,
        );
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.body).toBe(webhookBody);
      },
    );
  });

  it("forwards BytePlus built-in generation webhook POST bodies", async () => {
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
        const generationId = "550e8400-e29b-41d4-a716-446655440000";
        const webhookBody = JSON.stringify({
          id: "byteplus-task",
          status: "succeeded",
          content: {
            video_url: "https://ark-content.byteplus.example/test.mp4",
          },
        });
        const response = await fetch(
          `${origin}/api/webhooks/built-in-generations/byteplus/${generationId}?token=test-token`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: webhookBody,
          },
        );

        const payload = (await response.json()) as EchoPayload;
        expect(payload.method).toBe("POST");
        expect(payload.url).toBe(
          `/api/webhooks/built-in-generations/byteplus/${generationId}?token=test-token`,
        );
        expect(payload.headers["content-type"]).toContain("application/json");
        expect(payload.body).toBe(webhookBody);
      },
    );
  });
});
