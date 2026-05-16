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
const USER_MODEL_PREFERENCE_REWRITE_SOURCE = "/api/zero/user-model-preference";
const USER_MODEL_PREFERENCE_PATH = "/api/zero/user-model-preference";
const USER_MODEL_PREFERENCE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/user-model-preference/extra",
  "/api/zero/user-preferences",
] as const;
const PUSH_SUBSCRIPTIONS_REWRITE_SOURCE = "/api/zero/push-subscriptions";
const PUSH_SUBSCRIPTIONS_PATH = "/api/zero/push-subscriptions";
const PUSH_SUBSCRIPTIONS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/push-subscriptions/extra",
  "/api/zero/push-subscription",
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
          source: USER_MODEL_PREFERENCE_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/user-model-preference",
        },
        {
          source: "/api/zero/user-preferences",
          destination: "https://api.example.test/api/zero/user-preferences",
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
});
