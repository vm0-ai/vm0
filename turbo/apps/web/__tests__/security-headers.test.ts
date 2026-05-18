import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesApiBackendRewritePath } from "../api-backend-rewrites.js";

type PathMatchResult =
  | false
  | Record<string, string | readonly string[] | undefined>;

type GetPathMatch = (
  path: string,
  options?: {
    readonly removeUnnamedParams?: boolean;
    readonly strict?: boolean;
    readonly sensitive?: boolean;
  },
) => (pathname: string) => PathMatchResult;

const require = createRequire(import.meta.url);
const { getPathMatch } =
  require("next/dist/shared/lib/router/utils/path-match.js") as {
    readonly getPathMatch: GetPathMatch;
  };

const VOICE_CHAT_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const EMAIL_UNSUBSCRIBE_REWRITE_SOURCE = "/api/email/unsubscribe";
const EMAIL_UNSUBSCRIBE_PATH = "/api/email/unsubscribe";
const EMAIL_UNSUBSCRIBE_NEXT_NEGATIVE_PATHS = [
  "/api/email/unsubscribe/extra",
  "/api/email",
] as const;
const GENERATE_IMAGE_REWRITE_SOURCE = "/api/generate-image";
const GENERATE_IMAGE_PATH = "/api/generate-image";
const GENERATE_IMAGE_NEXT_NEGATIVE_PATHS = [
  "/api/generate-image/extra",
  "/api/generate",
] as const;
const GITHUB_OAUTH_CALLBACK_REWRITE_SOURCE = "/api/github/oauth/callback";
const GITHUB_OAUTH_CALLBACK_PATH = "/api/github/oauth/callback";
const GITHUB_OAUTH_CALLBACK_NEXT_NEGATIVE_PATHS = [
  "/api/github/oauth/callback/extra",
  "/api/github/oauth/install",
  "/api/github/oauth",
] as const;
const GITHUB_OAUTH_INSTALL_REWRITE_SOURCE = "/api/github/oauth/install";
const GITHUB_OAUTH_INSTALL_PATH = "/api/github/oauth/install";
const GITHUB_OAUTH_INSTALL_NEXT_NEGATIVE_PATHS = [
  "/api/github/oauth/install/extra",
  "/api/github/oauth",
] as const;
const LOGS_SEARCH_REWRITE_SOURCE = "/api/logs/search";
const LOGS_SEARCH_PATH = "/api/logs/search";
const LOGS_SEARCH_NEXT_NEGATIVE_PATHS = [
  "/api/logs/search/extra",
  "/api/logs",
] as const;
const INTEGRATIONS_GITHUB_REWRITE_SOURCE = "/api/integrations/github";
const INTEGRATIONS_GITHUB_PATH = "/api/integrations/github";
const INTEGRATIONS_GITHUB_NEXT_NEGATIVE_PATHS = [
  "/api/integrations/github/extra",
  "/api/integrations",
] as const;
const STORAGES_LIST_REWRITE_SOURCE = "/api/storages/list";
const STORAGES_LIST_PATH = "/api/storages/list";
const STORAGES_LIST_NEXT_NEGATIVE_PATHS = [
  "/api/storages/list/extra",
  "/api/storages",
  "/api/storages/lists",
] as const;
const USAGE_REWRITE_SOURCE = "/api/usage";
const USAGE_PATH = "/api/usage";
const USAGE_NEXT_NEGATIVE_PATHS = ["/api/usage/extra", "/api/usages"] as const;
const USER_MODEL_PREFERENCE_REWRITE_SOURCE = "/api/zero/user-model-preference";
const USER_MODEL_PREFERENCE_PATH = "/api/zero/user-model-preference";
const USER_MODEL_PREFERENCE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/user-model-preference/extra",
  "/api/zero/user-preferences",
] as const;
const ZERO_ME_MODEL_PROVIDER_TYPE_REWRITE_SOURCE =
  "/api/zero/me/model-providers/:type";
const ZERO_ME_MODEL_PROVIDER_TYPE_PATH =
  "/api/zero/me/model-providers/claude-code-oauth-token";
const ZERO_ME_MODEL_PROVIDER_TYPE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/me/model-providers",
  "/api/zero/me/model-providers/claude-code-oauth-token/oauth/authorize",
  "/api/zero/me/model-providers/claude-code-oauth-token/oauth/callback",
  "/api/zero/me/model-providers/claude-code-oauth-token/extra",
] as const;
const PUSH_SUBSCRIPTIONS_REWRITE_SOURCE = "/api/zero/push-subscriptions";
const PUSH_SUBSCRIPTIONS_PATH = "/api/zero/push-subscriptions";
const PUSH_SUBSCRIPTIONS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/push-subscriptions/extra",
  "/api/zero/push-subscription",
] as const;
const QUEUE_POSITION_REWRITE_SOURCE = "/api/zero/queue-position";
const QUEUE_POSITION_PATH = "/api/zero/queue-position";
const QUEUE_POSITION_NEXT_NEGATIVE_PATHS = [
  "/api/zero/queue-position/extra",
  "/api/zero/queue-positions",
] as const;
const PERMISSION_ACCESS_REQUESTS_REWRITE_SOURCE =
  "/api/zero/permission-access-requests";
const PERMISSION_ACCESS_REQUESTS_PATH = "/api/zero/permission-access-requests";
const PERMISSION_ACCESS_REQUESTS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/permission-access-requests/extra",
  "/api/zero/permission-access-request",
] as const;
const ZERO_ORG_LIST_REWRITE_SOURCE = "/api/zero/org/list";
const ZERO_ORG_LIST_PATH = "/api/zero/org/list";
const ZERO_ORG_LIST_NEXT_NEGATIVE_PATHS = [
  "/api/zero/org/list/extra",
  "/api/zero/org/lists",
] as const;
const VOICE_IO_TTS_REWRITE_SOURCE = "/api/zero/voice-io/tts";
const VOICE_IO_TTS_PATH = "/api/zero/voice-io/tts";
const VOICE_IO_TTS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/voice-io/tts/extra",
  "/api/zero/voice-io/quota",
  "/api/zero/voice-io/speech",
  "/api/zero/voice-io/stt",
] as const;
const VOICE_CHAT_SESSION_REWRITE_SOURCE =
  "/api/zero/voice-chat/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const VOICE_CHAT_TOKEN_REWRITE_SOURCE = "/api/zero/voice-chat/token";
const VOICE_CHAT_ITEM_APPEND_REWRITE_SOURCE = `${VOICE_CHAT_SESSION_REWRITE_SOURCE}/items`;
const VOICE_CHAT_TASKS_REWRITE_SOURCE = `${VOICE_CHAT_SESSION_REWRITE_SOURCE}/tasks`;
const VOICE_CHAT_TRIGGER_REASONING_REWRITE_SOURCE = `${VOICE_CHAT_SESSION_REWRITE_SOURCE}/trigger-reasoning`;
const VOICE_CHAT_SESSION_PATH = `/api/zero/voice-chat/${VOICE_CHAT_SESSION_ID}`;
const VOICE_CHAT_TOKEN_PATH = "/api/zero/voice-chat/token";
const VOICE_CHAT_ITEM_APPEND_PATH = `${VOICE_CHAT_SESSION_PATH}/items`;
const VOICE_CHAT_TASKS_PATH = `${VOICE_CHAT_SESSION_PATH}/tasks`;
const VOICE_CHAT_TRIGGER_REASONING_PATH = `${VOICE_CHAT_SESSION_PATH}/trigger-reasoning`;
const STRIPE_CLI_AUTH_SESSIONS_REWRITE_SOURCE =
  "/api/zero/connectors/stripe/cli-auth/sessions";
const STRIPE_CLI_AUTH_SESSIONS_PATH =
  "/api/zero/connectors/stripe/cli-auth/sessions";
const STRIPE_CLI_AUTH_SESSIONS_COMPLETE_PATH =
  "/api/zero/connectors/stripe/cli-auth/sessions/complete";
const VOICE_CHAT_ITEM_APPEND_NEXT_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token",
  "/api/zero/voice-chat/token/items",
  VOICE_CHAT_TASKS_PATH,
  VOICE_CHAT_TRIGGER_REASONING_PATH,
  "/api/zero/voice-chat/not-a-uuid/items",
] as const;
const VOICE_CHAT_TASKS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token",
  "/api/zero/voice-chat/token/tasks",
  VOICE_CHAT_ITEM_APPEND_PATH,
  VOICE_CHAT_TRIGGER_REASONING_PATH,
  "/api/zero/voice-chat/not-a-uuid/tasks",
] as const;
const VOICE_CHAT_TRIGGER_REASONING_NEXT_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token",
  "/api/zero/voice-chat/token/trigger-reasoning",
  "/api/zero/voice-chat/not-a-uuid/trigger-reasoning",
  VOICE_CHAT_ITEM_APPEND_PATH,
  VOICE_CHAT_TASKS_PATH,
] as const;
const VOICE_CHAT_SESSION_REWRITE_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/not-a-uuid",
] as const;
const VOICE_CHAT_TOKEN_NEXT_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token/extra",
  "/api/zero/voice-chat/token/items",
  "/api/zero/voice-chat/token/tasks",
  "/api/zero/voice-chat/token/trigger-reasoning",
  VOICE_CHAT_SESSION_PATH,
  VOICE_CHAT_ITEM_APPEND_PATH,
  VOICE_CHAT_TASKS_PATH,
  VOICE_CHAT_TRIGGER_REASONING_PATH,
  "/api/zero/voice-chat/not-a-uuid",
] as const;
const VOICE_CHAT_TOKEN_REWRITE_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token/extra",
  "/api/zero/voice-chat/token/items",
  "/api/zero/voice-chat/token/tasks",
  "/api/zero/voice-chat/token/trigger-reasoning",
  "/api/zero/voice-chat/not-a-uuid",
] as const;
const VOICE_CHAT_ITEM_APPEND_REWRITE_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token/items",
  "/api/zero/voice-chat/not-a-uuid/items",
] as const;
const VOICE_CHAT_TASKS_REWRITE_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token/tasks",
  "/api/zero/voice-chat/not-a-uuid/tasks",
] as const;
const VOICE_CHAT_TRIGGER_REASONING_REWRITE_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token/trigger-reasoning",
  "/api/zero/voice-chat/not-a-uuid/trigger-reasoning",
] as const;

// Import the nextConfig to test headers() function
// next.config.js exports the Sentry-wrapped config, so we need to extract headers from the raw config
// We test the headers function by dynamically importing and extracting the config

async function getSecurityHeaders(): Promise<
  Array<{ key: string; value: string }>
> {
  // Dynamic import to get the module fresh
  const configModule = await import("../next.config.js");
  const config = configModule.default;

  // The exported config is wrapped by Sentry, but headers() is preserved
  // Next.js config headers() returns an array of { source, headers } objects
  if (!config.headers) {
    throw new Error("headers() function not found in Next.js config");
  }
  const headerEntries = await config.headers();
  const catchAllEntry = headerEntries.find((entry: { source: string }) => {
    return entry.source === "/(.*)";
  });
  return catchAllEntry?.headers ?? [];
}

interface RewriteEntry {
  readonly source: string;
  readonly destination: string;
}

async function getBeforeFileRewrites(): Promise<RewriteEntry[]> {
  const configModule = await import("../next.config.js");
  const config = configModule.default;

  if (!config.rewrites) {
    throw new Error("rewrites() function not found in Next.js config");
  }

  const rewrites = await config.rewrites();
  if (Array.isArray(rewrites)) {
    return rewrites;
  }
  return rewrites.beforeFiles ?? [];
}

function findHeader(
  headers: Array<{ key: string; value: string }>,
  name: string,
): string | undefined {
  return headers.find((h) => {
    return h.key === name;
  })?.value;
}

describe("Security Response Headers", () => {
  it("should include all 5 ASVS-required security headers", async () => {
    const headers = await getSecurityHeaders();
    const headerNames = headers.map((h) => {
      return h.key;
    });

    expect(headerNames).toContain("X-Frame-Options");
    expect(headerNames).toContain("X-Content-Type-Options");
    expect(headerNames).toContain("Referrer-Policy");
    expect(headerNames).toContain("Strict-Transport-Security");
    expect(headerNames).toContain("Content-Security-Policy");
  });

  it("should set X-Frame-Options to DENY", async () => {
    const headers = await getSecurityHeaders();
    expect(findHeader(headers, "X-Frame-Options")).toBe("DENY");
  });

  it("should set X-Content-Type-Options to nosniff", async () => {
    const headers = await getSecurityHeaders();
    expect(findHeader(headers, "X-Content-Type-Options")).toBe("nosniff");
  });

  it("should set Referrer-Policy to strict-origin-when-cross-origin", async () => {
    const headers = await getSecurityHeaders();
    expect(findHeader(headers, "Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("should set HSTS with max-age of 1 year and includeSubDomains", async () => {
    const headers = await getSecurityHeaders();
    const hsts = findHeader(headers, "Strict-Transport-Security");
    expect(hsts).toBe("max-age=31536000; includeSubDomains");
  });

  describe("Content-Security-Policy", () => {
    it("should use permissive script-src with unsafe-inline for phase 1", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("script-src");
      expect(csp).toContain("'unsafe-inline'");
    });

    it("should allow inline styles via style-src", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("style-src");
      expect(csp).toContain("'unsafe-inline'");
    });

    it("should allow unsafe-eval for Termly embed-policy.min.js", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("'unsafe-eval'");
    });

    it("should deny frame-ancestors", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("frame-ancestors 'none'");
    });

    it("should use permissive default-src for phase 1", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("default-src *");
    });

    it("should restrict worker-src to self and blob: only", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("worker-src 'self' blob:");
    });
  });
});

describe("API backend rewrites", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should proxy migrated API backend routes to apps/api", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();

    expect(rewrites).toEqual(
      expect.arrayContaining([
        {
          source: "/api/device-token",
          destination: "https://api.example.test/api/device-token",
        },
        {
          source: "/api/device-token/poll",
          destination: "https://api.example.test/api/device-token/poll",
        },
        {
          source: EMAIL_UNSUBSCRIBE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/email/unsubscribe",
        },
        {
          source: GENERATE_IMAGE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/generate-image",
        },
        {
          source: GITHUB_OAUTH_CALLBACK_REWRITE_SOURCE,
          destination: "https://api.example.test/api/github/oauth/callback",
        },
        {
          source: GITHUB_OAUTH_INSTALL_REWRITE_SOURCE,
          destination: "https://api.example.test/api/github/oauth/install",
        },
        {
          source: LOGS_SEARCH_REWRITE_SOURCE,
          destination: "https://api.example.test/api/logs/search",
        },
        {
          source: INTEGRATIONS_GITHUB_REWRITE_SOURCE,
          destination: "https://api.example.test/api/integrations/github",
        },
        {
          source: STORAGES_LIST_REWRITE_SOURCE,
          destination: "https://api.example.test/api/storages/list",
        },
        {
          source: USAGE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/usage",
        },
        {
          source: "/api/agentphone/:path*",
          destination: "https://api.example.test/api/agentphone/:path*",
        },
        {
          source: "/api/internal/callbacks/agentphone",
          destination:
            "https://api.example.test/api/internal/callbacks/agentphone",
        },
        {
          source: "/api/internal/event-consumers/agentphone-typing",
          destination:
            "https://api.example.test/api/internal/event-consumers/agentphone-typing",
        },
        {
          source: "/api/user/export",
          destination: "https://api.example.test/api/user/export",
        },
        {
          source: STRIPE_CLI_AUTH_SESSIONS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/connectors/stripe/cli-auth/sessions",
        },
        {
          source: "/api/zero/devices/bb0/confirm",
          destination: "https://api.example.test/api/zero/devices/bb0/confirm",
        },
        {
          source:
            "/api/zero/me/model-providers/codex-oauth-token/oauth/authorize",
          destination:
            "https://api.example.test/api/zero/me/model-providers/codex-oauth-token/oauth/authorize",
        },
        {
          source:
            "/api/zero/me/model-providers/codex-oauth-token/oauth/callback",
          destination:
            "https://api.example.test/api/zero/me/model-providers/codex-oauth-token/oauth/callback",
        },
        {
          source: "/api/zero/built-in-generations/:path*",
          destination:
            "https://api.example.test/api/zero/built-in-generations/:path*",
        },
        {
          source: "/api/zero/image-io/generate",
          destination: "https://api.example.test/api/zero/image-io/generate",
        },
        {
          source: "/api/zero/presentation-io/generate",
          destination:
            "https://api.example.test/api/zero/presentation-io/generate",
        },
        {
          source: "/api/zero/local-agent/:path*",
          destination: "https://api.example.test/api/zero/local-agent/:path*",
        },
        {
          source: "/api/zero/usage/insight",
          destination: "https://api.example.test/api/zero/usage/insight",
        },
        {
          source: "/api/zero/usage/members",
          destination: "https://api.example.test/api/zero/usage/members",
        },
        {
          source: "/api/zero/usage/runs",
          destination: "https://api.example.test/api/zero/usage/runs",
        },
        {
          source: "/api/zero/video-io/generate",
          destination: "https://api.example.test/api/zero/video-io/generate",
        },
        {
          source: "/api/zero/integrations/phone/:path*",
          destination:
            "https://api.example.test/api/zero/integrations/phone/:path*",
        },
        {
          source: "/api/zero/uploads/complete",
          destination: "https://api.example.test/api/zero/uploads/complete",
        },
        {
          source: "/api/zero/uploads/prepare",
          destination: "https://api.example.test/api/zero/uploads/prepare",
        },
        {
          source: PUSH_SUBSCRIPTIONS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/push-subscriptions",
        },
        {
          source: QUEUE_POSITION_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/queue-position",
        },
        {
          source: PERMISSION_ACCESS_REQUESTS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/permission-access-requests",
        },
        {
          source: "/api/zero/secrets",
          destination: "https://api.example.test/api/zero/secrets",
        },
        {
          source: USER_MODEL_PREFERENCE_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/user-model-preference",
        },
        {
          source: ZERO_ME_MODEL_PROVIDER_TYPE_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/me/model-providers/:type",
        },
        {
          source: "/api/zero/user-preferences",
          destination: "https://api.example.test/api/zero/user-preferences",
        },
        {
          source: ZERO_ORG_LIST_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/org/list",
        },
        {
          source: "/api/zero/voice-io/speech",
          destination: "https://api.example.test/api/zero/voice-io/speech",
        },
        {
          source: "/api/zero/voice-io/stt",
          destination: "https://api.example.test/api/zero/voice-io/stt",
        },
        {
          source: VOICE_IO_TTS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/voice-io/tts",
        },
        {
          source: "/api/zero/voice-chat",
          destination: "https://api.example.test/api/zero/voice-chat",
        },
        {
          source: VOICE_CHAT_TOKEN_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/voice-chat/token",
        },
        {
          source: VOICE_CHAT_SESSION_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/voice-chat/:id",
        },
        {
          source: VOICE_CHAT_ITEM_APPEND_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/voice-chat/:id/items",
        },
        {
          source: VOICE_CHAT_TASKS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/voice-chat/:id/tasks",
        },
        {
          source: VOICE_CHAT_TRIGGER_REASONING_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/voice-chat/:id/trigger-reasoning",
        },
        {
          source: "/api/zero/web/download-file",
          destination: "https://api.example.test/api/zero/web/download-file",
        },
      ]),
    );
  });

  it("should match only the exact Stripe CLI auth sessions rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === STRIPE_CLI_AUTH_SESSIONS_REWRITE_SOURCE;
    });
    const exactIndex = rewrites.findIndex((entry) => {
      return entry.source === STRIPE_CLI_AUTH_SESSIONS_REWRITE_SOURCE;
    });
    const childIndex = rewrites.findIndex((entry) => {
      return (
        entry.source === `${STRIPE_CLI_AUTH_SESSIONS_REWRITE_SOURCE}/:path*`
      );
    });
    expect(rewrite).toStrictEqual({
      source: STRIPE_CLI_AUTH_SESSIONS_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/connectors/stripe/cli-auth/sessions",
    });
    expect(exactIndex).toBeGreaterThanOrEqual(0);
    expect(childIndex).toBeGreaterThan(exactIndex);

    const matcher = getPathMatch(STRIPE_CLI_AUTH_SESSIONS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(STRIPE_CLI_AUTH_SESSIONS_PATH)).toStrictEqual({});
    expect(matcher(STRIPE_CLI_AUTH_SESSIONS_COMPLETE_PATH)).toBe(false);
  });

  it("should match only the exact email unsubscribe rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === EMAIL_UNSUBSCRIBE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: EMAIL_UNSUBSCRIBE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/email/unsubscribe",
    });

    const matcher = getPathMatch(EMAIL_UNSUBSCRIBE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(EMAIL_UNSUBSCRIBE_PATH)).toStrictEqual({});
    for (const pathname of EMAIL_UNSUBSCRIBE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact generate image rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === GENERATE_IMAGE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: GENERATE_IMAGE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/generate-image",
    });

    const matcher = getPathMatch(GENERATE_IMAGE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(GENERATE_IMAGE_PATH)).toStrictEqual({});
    for (const pathname of GENERATE_IMAGE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact GitHub OAuth install rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === GITHUB_OAUTH_INSTALL_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: GITHUB_OAUTH_INSTALL_REWRITE_SOURCE,
      destination: "https://api.example.test/api/github/oauth/install",
    });

    const matcher = getPathMatch(GITHUB_OAUTH_INSTALL_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(GITHUB_OAUTH_INSTALL_PATH)).toStrictEqual({});
    for (const pathname of GITHUB_OAUTH_INSTALL_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact GitHub OAuth callback rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === GITHUB_OAUTH_CALLBACK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: GITHUB_OAUTH_CALLBACK_REWRITE_SOURCE,
      destination: "https://api.example.test/api/github/oauth/callback",
    });

    const matcher = getPathMatch(GITHUB_OAUTH_CALLBACK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(GITHUB_OAUTH_CALLBACK_PATH)).toStrictEqual({});
    for (const pathname of GITHUB_OAUTH_CALLBACK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact logs search rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === LOGS_SEARCH_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: LOGS_SEARCH_REWRITE_SOURCE,
      destination: "https://api.example.test/api/logs/search",
    });

    const matcher = getPathMatch(LOGS_SEARCH_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(LOGS_SEARCH_PATH)).toStrictEqual({});
    for (const pathname of LOGS_SEARCH_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact GitHub integration rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === INTEGRATIONS_GITHUB_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: INTEGRATIONS_GITHUB_REWRITE_SOURCE,
      destination: "https://api.example.test/api/integrations/github",
    });

    const matcher = getPathMatch(INTEGRATIONS_GITHUB_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(INTEGRATIONS_GITHUB_PATH)).toStrictEqual({});
    for (const pathname of INTEGRATIONS_GITHUB_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact storages list rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === STORAGES_LIST_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: STORAGES_LIST_REWRITE_SOURCE,
      destination: "https://api.example.test/api/storages/list",
    });

    const matcher = getPathMatch(STORAGES_LIST_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(STORAGES_LIST_PATH)).toStrictEqual({});
    for (const pathname of STORAGES_LIST_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact usage rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === USAGE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: USAGE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/usage",
    });

    const matcher = getPathMatch(USAGE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(USAGE_PATH)).toStrictEqual({});
    for (const pathname of USAGE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact push subscriptions rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === PUSH_SUBSCRIPTIONS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: PUSH_SUBSCRIPTIONS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/push-subscriptions",
    });

    const matcher = getPathMatch(PUSH_SUBSCRIPTIONS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(PUSH_SUBSCRIPTIONS_PATH)).toStrictEqual({});
    for (const pathname of PUSH_SUBSCRIPTIONS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact queue position rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === QUEUE_POSITION_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: QUEUE_POSITION_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/queue-position",
    });

    const matcher = getPathMatch(QUEUE_POSITION_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(QUEUE_POSITION_PATH)).toStrictEqual({});
    for (const pathname of QUEUE_POSITION_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact permission access requests rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === PERMISSION_ACCESS_REQUESTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: PERMISSION_ACCESS_REQUESTS_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/permission-access-requests",
    });

    const matcher = getPathMatch(PERMISSION_ACCESS_REQUESTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(PERMISSION_ACCESS_REQUESTS_PATH)).toStrictEqual({});
    for (const pathname of PERMISSION_ACCESS_REQUESTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact user model preference rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === USER_MODEL_PREFERENCE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: USER_MODEL_PREFERENCE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/user-model-preference",
    });

    const matcher = getPathMatch(USER_MODEL_PREFERENCE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(USER_MODEL_PREFERENCE_PATH)).toStrictEqual({});
    for (const pathname of USER_MODEL_PREFERENCE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero org list rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_ORG_LIST_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_ORG_LIST_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/org/list",
    });

    const matcher = getPathMatch(ZERO_ORG_LIST_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_ORG_LIST_PATH)).toStrictEqual({});
    for (const pathname of ZERO_ORG_LIST_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for zero me model-provider type rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_ME_MODEL_PROVIDER_TYPE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_ME_MODEL_PROVIDER_TYPE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/me/model-providers/:type",
    });

    const matcher = getPathMatch(ZERO_ME_MODEL_PROVIDER_TYPE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_ME_MODEL_PROVIDER_TYPE_PATH)).toStrictEqual({
      type: "claude-code-oauth-token",
    });
    for (const pathname of ZERO_ME_MODEL_PROVIDER_TYPE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact voice-io tts rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === VOICE_IO_TTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: VOICE_IO_TTS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/voice-io/tts",
    });

    const matcher = getPathMatch(VOICE_IO_TTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(VOICE_IO_TTS_PATH)).toStrictEqual({});
    for (const pathname of VOICE_IO_TTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped voice-chat session detail rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === VOICE_CHAT_SESSION_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: VOICE_CHAT_SESSION_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/voice-chat/:id",
    });

    const matcher = getPathMatch(VOICE_CHAT_SESSION_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(VOICE_CHAT_SESSION_PATH)).toStrictEqual({
      id: VOICE_CHAT_SESSION_ID,
    });
    expect(matcher("/api/zero/voice-chat/token")).toBe(false);
    expect(matcher(`${VOICE_CHAT_SESSION_PATH}/tasks`)).toBe(false);
    expect(matcher(VOICE_CHAT_ITEM_APPEND_PATH)).toBe(false);
    expect(matcher(VOICE_CHAT_TRIGGER_REASONING_PATH)).toBe(false);
    expect(matcher("/api/zero/voice-chat/not-a-uuid")).toBe(false);
  });

  it("should match only the exact voice-chat token rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === VOICE_CHAT_TOKEN_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: VOICE_CHAT_TOKEN_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/voice-chat/token",
    });

    const matcher = getPathMatch(VOICE_CHAT_TOKEN_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(VOICE_CHAT_TOKEN_PATH)).toStrictEqual({});
    for (const pathname of VOICE_CHAT_TOKEN_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped voice-chat item append rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === VOICE_CHAT_ITEM_APPEND_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: VOICE_CHAT_ITEM_APPEND_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/voice-chat/:id/items",
    });

    const matcher = getPathMatch(VOICE_CHAT_ITEM_APPEND_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(VOICE_CHAT_ITEM_APPEND_PATH)).toStrictEqual({
      id: VOICE_CHAT_SESSION_ID,
    });
    for (const pathname of VOICE_CHAT_ITEM_APPEND_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped voice-chat trigger-reasoning rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === VOICE_CHAT_TRIGGER_REASONING_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: VOICE_CHAT_TRIGGER_REASONING_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/voice-chat/:id/trigger-reasoning",
    });

    const matcher = getPathMatch(VOICE_CHAT_TRIGGER_REASONING_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(VOICE_CHAT_TRIGGER_REASONING_PATH)).toStrictEqual({
      id: VOICE_CHAT_SESSION_ID,
    });
    for (const pathname of VOICE_CHAT_TRIGGER_REASONING_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped voice-chat session detail paths", () => {
    expect(matchesApiBackendRewritePath(VOICE_CHAT_SESSION_PATH)).toBe(true);
    for (const pathname of VOICE_CHAT_SESSION_REWRITE_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact voice-chat token path", () => {
    expect(matchesApiBackendRewritePath(VOICE_CHAT_TOKEN_PATH)).toBe(true);
    for (const pathname of VOICE_CHAT_TOKEN_REWRITE_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped voice-chat item append paths", () => {
    expect(matchesApiBackendRewritePath(VOICE_CHAT_ITEM_APPEND_PATH)).toBe(
      true,
    );
    for (const pathname of VOICE_CHAT_ITEM_APPEND_REWRITE_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped voice-chat task rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === VOICE_CHAT_TASKS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: VOICE_CHAT_TASKS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/voice-chat/:id/tasks",
    });

    const matcher = getPathMatch(VOICE_CHAT_TASKS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(VOICE_CHAT_TASKS_PATH)).toStrictEqual({
      id: VOICE_CHAT_SESSION_ID,
    });
    for (const pathname of VOICE_CHAT_TASKS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped voice-chat task paths", () => {
    expect(matchesApiBackendRewritePath(VOICE_CHAT_TASKS_PATH)).toBe(true);
    for (const pathname of VOICE_CHAT_TASKS_REWRITE_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped voice-chat trigger-reasoning paths", () => {
    expect(
      matchesApiBackendRewritePath(VOICE_CHAT_TRIGGER_REASONING_PATH),
    ).toBe(true);
    for (const pathname of VOICE_CHAT_TRIGGER_REASONING_REWRITE_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should not add a broad /api catch-all rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();

    expect(
      rewrites.some((rewrite) => {
        return rewrite.source === "/api/:path*";
      }),
    ).toBe(false);
  });

  it("should match the zero web download route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath("/api/zero/web/download-file")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/web/download-file/extra"),
    ).toBe(false);
  });

  it("should match the usage members route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath("/api/zero/usage/members")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/usage/members/extra")).toBe(
      false,
    );
  });

  it("should match the zero org list route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_ORG_LIST_PATH)).toBe(true);
    for (const pathname of ZERO_ORG_LIST_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero secrets route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath("/api/zero/secrets")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/secrets/extra")).toBe(false);
  });
});
