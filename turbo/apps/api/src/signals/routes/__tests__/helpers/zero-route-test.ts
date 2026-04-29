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

interface MockS3Object {
  readonly bucket: string;
  readonly key: string;
  readonly size: number;
  readonly lastModified?: Date;
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

export function mockS3ListObjects(
  context: TestContext,
  objects: readonly MockS3Object[],
): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
    const contents = objects
      .filter((object) => {
        return object.bucket === bucket && object.key.startsWith(prefix);
      })
      .map((object) => {
        return {
          Key: object.key,
          Size: object.size,
          LastModified:
            object.lastModified ?? new Date("2025-01-01T00:00:00.000Z"),
        };
      });

    return Promise.resolve({ Contents: contents });
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
