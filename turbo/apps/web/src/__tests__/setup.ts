import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { server } from "../mocks/server";

// Stub environment variables before any imports.
// Using vi.hoisted() ensures stubs run before module imports.
//
// All env vars are explicitly stubbed here for deterministic test behavior.
// Note: DATABASE_URL is NOT stubbed because it differs between environments
// (local dev vs CI) and comes from .env / .env.local.
//
// resetEnv() is called in vi.hoisted() for initial import-time validation AND
// in beforeEach to re-apply defaults after Vitest's unstubEnvs auto-cleanup.
const resetEnv = vi.hoisted(() => {
  const fn = () => {
    // Required env vars from env.ts schema
    vi.stubEnv(
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "pk_test_mock_instance.clerk.accounts.dev$",
    );
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_mock_secret_key_for_testing");
    vi.stubEnv("E2B_API_KEY", "e2b_test_api_key");
    vi.stubEnv("R2_ACCOUNT_ID", "test-account-id");
    vi.stubEnv("R2_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-bucket");
    // Optional env vars
    vi.stubEnv("AXIOM_DATASET_SUFFIX", "dev");
    // Slack integration test vars
    vi.stubEnv("SLACK_CLIENT_ID", "test-slack-client-id");
    vi.stubEnv("SLACK_CLIENT_SECRET", "test-slack-client-secret");
    vi.stubEnv("SLACK_SIGNING_SECRET", "test-slack-signing-secret");
    // 64 hex chars = 32 bytes encryption key for sandbox token signing
    vi.stubEnv(
      "SECRETS_ENCRYPTION_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    // 64 hex chars = 32 bytes secret for official runner authentication
    vi.stubEnv(
      "OFFICIAL_RUNNER_SECRET",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    vi.stubEnv("SLACK_REDIRECT_BASE_URL", "https://test.example.com");
    // API URL for compose job webhooks
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    // Platform UI URL
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_URL", "http://localhost:3001");
    // Initialize Next.js after() callback queue (shared with test-helpers.ts flushAfter)
    globalThis.nextAfterCallbacks = [];
  };
  fn(); // Initial call before imports
  return fn;
});

// Import reloadEnv AFTER vi.hoisted() has set up the stubs
import { reloadEnv } from "../env";

// Mock server-only package (no-op in tests)
// This package throws when imported outside of a server component
vi.mock("server-only", () => ({}));

// Mock Next.js after() to capture callbacks for controlled execution in tests.
// Tests can drain the queue with context.mocks.flushAfter().
// Supports both function and promise arguments to match Next.js behavior.
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return {
    ...original,
    after: (fnOrPromise: (() => Promise<unknown>) | Promise<unknown>) => {
      if (typeof fnOrPromise === "function") {
        globalThis.nextAfterCallbacks.push(fnOrPromise);
      } else {
        // Wrap promise in a function for consistent handling in flushAfter()
        globalThis.nextAfterCallbacks.push(() => fnOrPromise);
      }
    },
  };
});

// Mock Clerk authentication
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  clerkClient: vi.fn(),
  clerkMiddleware: vi.fn(),
  createRouteMatcher: vi.fn(),
}));

// Mock E2B sandbox
vi.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    create: vi.fn(),
    connect: vi.fn(),
  },
}));

// Mock AWS S3
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(function () {
    return { send: vi.fn() };
  }),
  ListObjectsV2Command: vi.fn(),
  GetObjectCommand: vi.fn(),
  PutObjectCommand: vi.fn(),
  DeleteObjectsCommand: vi.fn(),
  HeadObjectCommand: vi.fn(),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(),
}));

// Mock Slack Web API — singleton pattern: every `new WebClient()` returns the same mock object.
// `clearMocks: true` in vitest config only clears mock.calls/mock.results between tests,
// so the implementations persist while call history resets automatically.
vi.mock("@slack/web-api", () => {
  const mockClient = {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "mock.ts" }),
      postEphemeral: vi
        .fn()
        .mockResolvedValue({ ok: true, message_ts: "mock.ts" }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    views: {
      publish: vi.fn().mockResolvedValue({ ok: true }),
      open: vi.fn().mockResolvedValue({ ok: true, view: { id: "V-mock" } }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    oauth: {
      v2: {
        access: vi.fn().mockResolvedValue({ ok: true }),
      },
    },
    conversations: {
      replies: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
      history: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
  return {
    WebClient: vi.fn().mockImplementation(function () {
      return mockClient;
    }),
  };
});

// Mock Axiom packages
// The @axiomhq/logging Logger class needs proper method implementations
vi.mock("@axiomhq/js", () => ({
  Axiom: vi.fn(),
}));

vi.mock("@axiomhq/logging", () => ({
  Logger: vi.fn().mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })),
  AxiomJSTransport: vi.fn(),
}));

// MSW server lifecycle
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

// Re-apply env defaults and refresh env() cache before each test.
// Vitest's unstubEnvs: true restores real process.env after each test,
// so we re-stub defaults here to ensure deterministic test state.
beforeEach(() => {
  resetEnv();
  reloadEnv();
  globalThis.nextAfterCallbacks = [];
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
