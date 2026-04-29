import { afterEach } from "vitest";

import type { TestContext } from "../../../../__tests__/test-helpers";

type ClerkOrgRole = "org:admin" | "org:member";

export function mockClerkSession(
  context: TestContext,
  userId: string,
  orgId: string | null,
  orgRole: ClerkOrgRole | undefined = orgId ? "org:admin" : undefined,
): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId,
        orgId,
        orgRole,
      };
    },
  });
}

export function createFixtureTracker<T>(
  cleanup: (fixture: T) => Promise<void>,
): (fixturePromise: Promise<T>) => Promise<T> {
  const fixtures: T[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await cleanup(fixture);
      }
    }
  });

  return async (fixturePromise: Promise<T>): Promise<T> => {
    const fixture = await fixturePromise;
    fixtures.push(fixture);
    return fixture;
  };
}
