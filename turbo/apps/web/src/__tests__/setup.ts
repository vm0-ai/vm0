import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { server } from "../mocks/server";
import {
  nextAfterArgForms,
  nextAfterCallbacks,
  flushNextAsyncHooks,
  resetNextAfterHooks,
} from "./next-after-hooks";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Stub environment variables before any imports.
// Using vi.hoisted() ensures stubs run before module imports.
//
// All env vars used by env.ts are explicitly stubbed here for deterministic
// test behavior.
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
    vi.stubEnv("R2_ACCOUNT_ID", "test-account-id");
    vi.stubEnv("R2_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-bucket");
    vi.stubEnv("R2_USER_ARTIFACTS_BUCKET_NAME", "test-artifacts-bucket");
    vi.stubEnv("R2_USER_ARTIFACTS_ACCESS_KEY_ID", "test-artifacts-access-key");
    vi.stubEnv(
      "R2_USER_ARTIFACTS_SECRET_ACCESS_KEY",
      "test-artifacts-secret-key",
    );
    vi.stubEnv("PUBLIC_ARTIFACTS_BASE_URL", "https://cdn.vm7.io");
    // API URL for compose job webhooks
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    // App UI URL
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3001");
  };
  fn(); // Initial call before imports
  return fn;
});

// Import reloadEnv AFTER vi.hoisted() has set up the stubs
import { reloadEnv } from "../env";

// Mock Next.js after() to capture callbacks for controlled execution in tests.
// Tests can drain the queue with context.mocks.flushAfter().
// Supports both function and promise arguments to match Next.js behavior.
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return {
    ...original,
    after: (
      fnOrPromise: (() => unknown | Promise<unknown>) | Promise<unknown>,
    ) => {
      if (typeof fnOrPromise === "function") {
        nextAfterArgForms.push("fn");
        nextAfterCallbacks.push(fnOrPromise);
      } else {
        nextAfterArgForms.push("promise");
        // Wrap promise in a function for consistent handling in flushAfter()
        nextAfterCallbacks.push(() => {
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
  resetNextAfterHooks();
  server.use(
    http.post(OPENROUTER_URL, () => {
      return HttpResponse.json({
        choices: [{ message: { content: "Default OpenRouter response" } }],
      });
    }),
  );
});

afterEach(async () => {
  await flushNextAsyncHooks();
  resetNextAfterHooks();
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
