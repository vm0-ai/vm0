/**
 * Test Helper Utilities for Isolated Test Contexts
 *
 * This module provides utilities for creating isolated test environments
 * where each test has its own user context, eliminating the need for
 * cleanup between tests.
 *
 * Usage:
 *   const context = testContext();
 *
 *   test("my test", async () => {
 *     const user = await setupUser({ context });
 *     // user.userId and user.scopeId are unique to this test
 *     // No cleanup needed - data is isolated by unique IDs
 *   });
 */
import { afterEach } from "vitest";
import { randomUUID } from "crypto";
import { mockClerk, clearClerkMock } from "./clerk-mock";
import { initServices } from "../lib/init-services";
import {
  createTestDataContext,
  type TestDataContext,
} from "./api-test-helpers";
import { POST as createCompose } from "../../app/api/agent/composes/route";
import { POST as createScope } from "../../app/api/scope/route";
import { PUT as setCredential } from "../../app/api/credentials/route";
import { PUT as upsertModelProvider } from "../../app/api/model-providers/route";
import { POST as setModelProviderDefault } from "../../app/api/model-providers/[type]/set-default/route";

interface TestContext {
  readonly signal: AbortSignal;
  readonly ctx: TestDataContext;
}

export interface UserContext {
  readonly userId: string;
  readonly scopeId: string;
  readonly ctx: TestDataContext;
}

/**
 * Creates a test context that manages test lifecycle.
 * Call this once at the root scope of your describe block.
 *
 * The returned signal will be aborted after each test,
 * allowing cleanup handlers to run.
 *
 * Usage:
 *   describe("my tests", () => {
 *     const context = testContext();
 *
 *     test("test 1", async () => {
 *       const user = await setupUser({ context });
 *       // ...
 *     });
 *   });
 */
export function testContext(): TestContext {
  let controller = new AbortController();

  // Create test data context for API-based test data creation
  const ctx = createTestDataContext({
    scopeRoute: createScope,
    composeRoute: createCompose,
    credentialRoute: setCredential,
    modelProviderRoute: upsertModelProvider,
    setDefaultRoute: setModelProviderDefault,
  });

  afterEach(() => {
    // Clear Clerk mock
    clearClerkMock();

    // Abort the signal to trigger any cleanup handlers
    const error = new Error("Aborted due to finished test");
    error.name = "AbortError";
    controller.abort(error);

    // Create new controller for next test
    controller = new AbortController();
  });

  return {
    get signal(): AbortSignal {
      return controller.signal;
    },
    ctx,
  };
}

interface SetupUserOptions {
  context: TestContext;
  /** Optional prefix for the user ID (default: "test-user") */
  prefix?: string;
}

/**
 * Creates an isolated user context for a single test.
 * Each call creates a unique user ID and scope.
 *
 * Usage:
 *   const user = await setupUser({ context });
 *   // user.userId is unique, e.g., "test-user-1706123456789-a1b2c3d4"
 *   // user.scopeId is the created scope's ID
 *   // user.ctx provides API helpers for creating test data
 *
 * The Clerk mock is automatically configured for this user.
 */
export async function setupUser({
  context,
  prefix = "test-user",
}: SetupUserOptions): Promise<UserContext> {
  initServices();

  // Generate unique user ID
  const uniqueSuffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const userId = `${prefix}-${uniqueSuffix}`;

  // Mock Clerk for this user
  mockClerk({ userId });

  // Create scope via API
  const scopeData = await context.ctx.createScope(`scope-${uniqueSuffix}`);

  return {
    userId,
    scopeId: scopeData.id,
    ctx: context.ctx,
  };
}
