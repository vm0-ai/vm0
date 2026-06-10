import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";

import { zeroBuiltInGenerationContract } from "@vm0/api-contracts/contracts/zero-built-in-generation";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroBuiltInGenerationContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 60,
  });
}

describe("GET /api/zero/built-in-generations/:generationId BDD", () => {
  it("requires authentication, active organization, valid id, and file write capability", async () => {
    const generationId = randomUUID();

    const unauthenticated = await accept(
      client().get({ params: { generationId }, headers: {} }),
      [401],
    );

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const missingOrg = await accept(
      client().get({
        params: { generationId },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(missingOrg.body.error.code).toBe("BAD_REQUEST");
    expect(missingOrg.body.error.message).toContain(
      "Explicit org context required",
    );

    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const invalidId = await accept(
      client().get({
        params: { generationId: "not-a-uuid" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(invalidId.body.error.code).toBe("BAD_REQUEST");

    const token = zeroToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      capabilities: ["file:read"],
    });
    const missingCapability = await accept(
      client().get({
        params: { generationId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(missingCapability.body).toStrictEqual({
      error: {
        message: "Missing required capability: file:write",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 404 for an unknown generation in the caller's organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      client().get({
        params: { generationId: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Built-in generation not found",
        code: "NOT_FOUND",
      },
    });
  });
});
