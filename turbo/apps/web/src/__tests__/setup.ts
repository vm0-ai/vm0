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
    vi.stubEnv("DB_DRIVER", "pg");
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
    // ngrok (for computer connector)
    vi.stubEnv("NGROK_API_KEY", "test-ngrok-api-key");
    vi.stubEnv("NGROK_COMPUTER_CONNECTOR_DOMAIN", "computer.test.vm0.io");
    // Runner executor default group (runs dispatch to runner)
    // Uses "vm0" org which is hardcoded as public in isOfficialRunnerGroup
    vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/default");
    // AgentPhone integration
    vi.stubEnv("AGENTPHONE_API_KEY", "test-agentphone-api-key");
    vi.stubEnv("AGENTPHONE_API_BASE_URL", "https://api.agentphone.to");
    // API URL for compose job webhooks
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    // App UI URL
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3001");
    // Email integration (Resend)
    vi.stubEnv("RESEND_API_KEY", "re_test_api_key");
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_test_webhook_secret");
    vi.stubEnv("RESEND_FROM_DOMAIN", "vm7.bot");
    // GitHub App integration test vars
    vi.stubEnv("GITHUB_APP_ID", "123456");
    vi.stubEnv("GITHUB_APP_SLUG", "vm0-test-app");
    // Base64-encoded RSA private key for JWT signing in tests (2048-bit test key, NOT a production secret)
    vi.stubEnv(
      "GITHUB_APP_PRIVATE_KEY",
      "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JSUV2UUlCQURBTkJna3Foa2lHOXcwQkFRRUZBQVNDQktjd2dnU2pBZ0VBQW9JQkFRQ2FkZ0VnSzU4SVAzV3gKNkFvbDRxR09iTHhUV2dVd3pOckVrT0Z3anFIUEN6a2VXaHZuVWhBaDc5bnpVT1l5MG12akF0NFJTSFdGck9aNQp4eXVqS3p3OGNrY3ZiVDBrNmYyMHVsUHJNQStUSGMrYmZHQ1lNRmJzVk0vbTQydldtSkdTMDJ1bTIyZzAxb3lZCmxROEhEUXhRMjBva2tzclJ5c0lqWWx3WHloVWpoVFZnNkpGWVlVUEhiT2t1bHlhVmZUcVNmNmN3QUVGWTUrMWgKaUhFMmtBQllsdUFiY2JQeTBzVUIzblRxa2NuV3laWVBSTHplcUtUN1hEaDltL2hGSVJPWEtTS01ZWXZCWVROcQpaOXl5cDJpVHJsenR1NkZWcG1rdUlMZGpGQlJSQjg1azd5amlyZlp4NjExbWE0V3g1M05FTFB4ekY0QVRaZkdGCmlvR2s2WVZsQWdNQkFBRUNnZ0VBQ014NGozSFVyeFpZV01CUVZheWxpZFN4WEtrbjJ3b01XejZxak93ZkZRbDkKWVRoK1Z1ekNqUUJhQU1XR3UzWG5uZWlqcUVYaHBmSDl0Z210dDIrRzBLV3MzdXVBM0dtMDRWYnM0VnlkUW9MagorT1k2cFdpNWh1Qms0SERiaTMrbzZUMkFhQ0tlK3NXUEFFRWJlRW9hdmI5a0o1V3lGb1hQamM3MFVvbVpMeXI0CmZ6ODRDVGpBUFpMT1dDendJOVB6YURNdTFkL2J3bWdWNnpMN2pGaDU5Tlhka1FXdVd4TG1KVjV5dTBYdW5iZE8KbGlJbGFLTG9yQ045bTV0dksrOFFPYVRiM0VKckdCdm9HR2FqTThFKzU5TnRiazAwNGxuN3BLTnVDVzZ5SDBRTgpPM1A1VEFaT09CQUVieVZVZm80eW5wZTQ3VStyd296OHB5aWdCOFFXZ1FLQmdRREExU0ZhajB2cDNxN0hMSXFMCmsySU92ejZnVkEyS1IyRVdRbk5HRFdjT0UrVXJ2aC93bjVYN0lKTkFkQU9ORFFDQWFEa2hlSTFUMXFjYStSRWkKTzNaaVhXUlZ0QWRTdTJmenAveFMySkVqV05qT2UyTHd4Q2RmRmk1cEhQdnZNZWpQL0NsaHZyWFQzOE5xZ3dmNgpVV2t1ckpvRFR0SEFKRjF1dWNVbzVpT3k1UUtCZ1FETkR3dmFjRjFXbUd4bVJnM2pBanl2OEJVd2FSTTZCazc3Cmc1NE91MTk1dG54dUdpS2NQUHcyU3V5SWQ0bm9aaWQ5SWhuSUZzd2xQSDI1eWU5dVBwYkhNR2Njc0xLNTU0S1IKelpUZEg3NVpVUmo2OXYzTStJQi9PWmY3citkUk85ZGFNYUF6TFdRYWhjdjFXSDVMb1FxZjhoV0k1eEI3RnFKawpUaWtTdEpUZ2dRS0JnR1I4ckd6c3o3cUgrTHlDVVpCNnRWYktBbkM2WEhQNnpuVXpHNjhkdk41eEw3T2oyREVrCmVKdnRWYzc0cGdFVERYZmMyQ2pCRWFUbTd4MzNQUjZCcmllRVU0ejF5L3NvL2ZyVFI0SkVxUjJxWnhEeTY1UmMKSThoQlh0NFg1Skc1aUlFWi90YVk4MWY5KzIrOTZLSmhXbGFnUzRIOXlRQS84eENJYmwzcDBDQ2hBb0dBQ01ZQQpCOVNPNmNtVHVieDlrNXpnNDlZdDBlaHMvaXFPN292dkUwcEpCM2diVXNxamVIUFRocThsOTZERnNiL05LTGx3CnlQTFF3VGNaV2YyZDFPV3dwYzBZWEUzakY3a2tDUUQyd1k4K0lhd3FtWEkvNGFrd05rRk1rMlF2VFhaMS9GSHIKUE1WUVp5SWFXK0R4Wm1MNWhXWmlMWDFWWXk3UXUrSHNOL1NwK2dFQ2dZRUFvS1dhV3JXM2VEVkl5WFVtazRoQgo2OGt5RG9iWldpTGlkU2FlUG1UYk91Mnp3YWt3eTIraDhyUGpuZXl1eWgyYzNsZjlqYnhQM2NhU2JwV1JZQjFoCnQwVThUZ3JwMDZ3TlBvSUNiWWI1OU12UTBscXVpeG9IejUvbUhEb2dtTWhkcEM4NHlpSVd6TmgvQmxRSlVrbFgKaEZnT3dkWFloQ250Qi9Nc0YxMTdtdHc9Ci0tLS0tRU5EIFBSSVZBVEUgS0VZLS0tLS0K",
    );
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
vi.mock("server-only", () => {
  return {};
});

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
        globalThis.nextAfterCallbacks.push(() => {
          return fnOrPromise;
        });
      }
    },
  };
});

// Mock Clerk authentication
vi.mock("@clerk/nextjs/server", () => {
  return {
    auth: vi.fn(),
    clerkClient: vi.fn(),
    clerkMiddleware: vi.fn(),
    createRouteMatcher: vi.fn(),
  };
});

// Mock AWS S3
vi.mock("@aws-sdk/client-s3", () => {
  return {
    S3Client: vi.fn().mockImplementation(function () {
      return { send: vi.fn() };
    }),
    ListObjectsV2Command: vi.fn(),
    GetObjectCommand: vi.fn(),
    PutObjectCommand: vi.fn(),
    DeleteObjectsCommand: vi.fn(),
    HeadObjectCommand: vi.fn(),
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => {
  return {
    getSignedUrl: vi.fn(),
  };
});

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
      list: vi.fn().mockResolvedValue({ ok: true, channels: [] }),
      open: vi
        .fn()
        .mockResolvedValue({ ok: true, channel: { id: "D-mock-dm" } }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
    users: {
      info: vi.fn().mockResolvedValue({ ok: true, user: undefined }),
    },
    assistant: {
      threads: {
        setStatus: vi.fn().mockResolvedValue({ ok: true }),
      },
    },
  };
  return {
    WebClient: vi.fn().mockImplementation(function () {
      return mockClient;
    }),
  };
});

// Mock Svix webhook verification (used by Resend inbound webhooks)
vi.mock("svix", () => {
  return {
    Webhook: vi.fn().mockImplementation(function () {
      return {
        verify: vi.fn().mockImplementation((payload: string) => {
          return JSON.parse(payload);
        }),
      };
    }),
  };
});

// Mock Resend email service
vi.mock("resend", () => {
  const mockResend = {
    emails: {
      send: vi.fn().mockResolvedValue({ data: { id: "mock-email-id" } }),
      get: vi.fn().mockResolvedValue({
        data: { id: "mock-email-id", message_id: "<mock-message-id@vm7.bot>" },
      }),
      receiving: {
        get: vi.fn().mockResolvedValue({
          data: {
            from: "user@example.com",
            to: ["reply+token@vm7.bot"],
            subject: "Re: test",
            text: "Hello from email",
            html: "<p>Hello from email</p>",
            headers: {
              "authentication-results":
                "mx.resend.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
              "message-id": "<default-msg-id@example.com>",
            },
            attachments: [],
          },
        }),
        attachments: {
          list: vi.fn().mockResolvedValue({
            data: { object: "list", has_more: false, data: [] },
          }),
        },
      },
    },
    webhooks: {
      verify: vi.fn().mockReturnValue(true),
    },
  };
  return {
    Resend: vi.fn().mockImplementation(function () {
      return mockResend;
    }),
  };
});

// Mock Axiom packages
// The @axiomhq/logging Logger class needs proper method implementations
vi.mock("@axiomhq/js", () => {
  return {
    Axiom: vi.fn(),
  };
});

vi.mock("@axiomhq/logging", () => {
  return {
    Logger: vi.fn().mockImplementation(() => {
      return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
      };
    }),
    AxiomJSTransport: vi.fn(),
  };
});

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
