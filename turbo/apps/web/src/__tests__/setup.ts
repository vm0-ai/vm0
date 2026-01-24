import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
import { config } from "dotenv";

// Load environment variables from .env file
config({ path: "./.env" });

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

// Set test environment variables
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY =
  "pk_test_mock_instance.clerk.accounts.dev$";
process.env.CLERK_SECRET_KEY = "sk_test_mock_secret_key_for_testing";
process.env.AXIOM_DATASET_SUFFIX = "dev";
// 64 hex chars = 32 bytes encryption key for sandbox token signing
process.env.SECRETS_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
