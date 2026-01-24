import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Stub environment variables before any imports
// Using vi.hoisted() ensures stubs run before module imports
//
// All env vars are explicitly stubbed here for deterministic test behavior.
// Note: DATABASE_URL is NOT stubbed because it differs between environments:
// - Local dev: postgresql://postgres:postgres@localhost:5432/postgres
// - CI (GitHub Actions): postgresql://postgres@postgres:5432/postgres (service container)
vi.hoisted(() => {
  // Required env vars from env.ts schema
  vi.stubEnv(
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "pk_test_mock_instance.clerk.accounts.dev$",
  );
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_mock_secret_key_for_testing");
  vi.stubEnv("E2B_API_KEY", "e2b_test_api_key");
  vi.stubEnv("E2B_TEMPLATE_NAME", "test-template");
  vi.stubEnv("R2_ACCOUNT_ID", "test-account-id");
  vi.stubEnv("R2_ACCESS_KEY_ID", "test-access-key");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
  vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-bucket");
  // Optional env vars
  vi.stubEnv("AXIOM_DATASET_SUFFIX", "dev");
  // 64 hex chars = 32 bytes encryption key for sandbox token signing
  vi.stubEnv(
    "SECRETS_ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
});

// Mock server-only package (no-op in tests)
// This package throws when imported outside of a server component
vi.mock("server-only", () => ({}));

// Mock Clerk authentication
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  clerkClient: vi.fn(),
  clerkMiddleware: vi.fn(),
  createRouteMatcher: vi.fn(),
}));
