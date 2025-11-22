import "@testing-library/jest-dom/vitest";
import { vi, afterAll } from "vitest";
import { config } from "dotenv";
import { cleanupServices } from "../lib/init-services";

// Load environment variables from .env file
config({ path: "./.env" });

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

// Cleanup database connections after all tests in this file
afterAll(async () => {
  await cleanupServices();
});
