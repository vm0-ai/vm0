import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { beforeEach, expect } from "vitest";
import { zeroDeveloperSupportContract } from "@vm0/api-contracts/contracts/zero-developer-support";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteOrgMembership$,
  type OrgMembershipFixture,
  seedOrgMembership$,
} from "./helpers/zero-org-membership";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const trackUsage = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});
const trackMembership = createFixtureTracker<OrgMembershipFixture>(
  (fixture) => {
    return store.set(deleteOrgMembership$, fixture, context.signal);
  },
);

interface DeveloperSupportFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly runId: string;
}

interface RunSeedOptions {
  readonly continuedFromSessionId?: string | null;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: [],
    iat: seconds,
    exp: seconds + 60,
  });
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

function putObjectInput(): Record<string, unknown> {
  const call = context.mocks.s3.send.mock.calls.find(([command]) => {
    const input = commandInput(command);
    return input.Body !== undefined && input.ContentType === "application/zip";
  });
  if (!call) {
    throw new Error("expected S3 PutObjectCommand");
  }
  return commandInput(call[0]);
}

async function seedSupportRun(
  options: RunSeedOptions = {},
): Promise<DeveloperSupportFixture> {
  const fixture = await trackUsage(
    store.set(seedUsageInsightFixture$, undefined, context.signal),
  );
  await trackMembership(
    store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    ),
  );
  const { composeId } = await store.set(
    seedCompose$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      displayName: "Support Agent",
    },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId,
      status: "running",
      continuedFromSessionId: options.continuedFromSessionId,
    },
    context.signal,
  );

  return { ...fixture, composeId, runId };
}

function client() {
  return setupApp({ context })(zeroDeveloperSupportContract);
}

function submitDeveloperSupport(
  token: string | undefined,
  body: {
    readonly title: string;
    readonly description: string;
    readonly consentCode?: string;
  },
) {
  return client().submit({
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  });
}

function requireConsentCode(body: {
  readonly consentCode?: string;
  readonly reference?: string;
}): string {
  if (!body.consentCode) {
    throw new Error("expected consentCode response");
  }
  return body.consentCode;
}

function requireReference(body: {
  readonly consentCode?: string;
  readonly reference?: string;
}): string {
  if (!body.reference) {
    throw new Error("expected reference response");
  }
  return body.reference;
}

beforeEach(() => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [],
  });
  context.mocks.axiom.query.mockResolvedValue([]);
  context.mocks.s3.send.mockResolvedValue({});
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.com/developer-support.zip?sig=test",
  );
  mockOptionalEnv("PLAIN_API_KEY", undefined);
});

describe("POST /api/zero/developer-support", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      submitDeveloperSupport(undefined, {
        title: "Bug",
        description: "Something broke",
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for auth without run scope", async () => {
    const token = zeroToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: randomUUID(),
    });

    const response = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "This endpoint requires a zero token with runId and orgId",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns RUN_NOT_FOUND for a missing run", async () => {
    const fixture = await seedSupportRun();
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: randomUUID(),
    });

    const response = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [400],
    );

    expect(response.body.error.code).toBe("RUN_NOT_FOUND");
  });

  it("returns a deterministic consent code when consentCode is omitted", async () => {
    const fixture = await seedSupportRun();
    const token = zeroToken(fixture);

    const first = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );
    const second = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );

    expect(requireConsentCode(first.body)).toMatch(/^[0-9A-F]{4}$/);
    expect(second.body).toStrictEqual(first.body);
  });

  it("uses the same consent code across runs in the same session", async () => {
    const sessionId = randomUUID();
    const first = await seedSupportRun({ continuedFromSessionId: sessionId });
    const { runId: secondRunId } = await store.set(
      seedRun$,
      {
        orgId: first.orgId,
        userId: first.userId,
        composeId: first.composeId,
        status: "running",
        continuedFromSessionId: sessionId,
      },
      context.signal,
    );

    const firstResponse = await accept(
      submitDeveloperSupport(zeroToken(first), {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );
    const secondResponse = await accept(
      submitDeveloperSupport(zeroToken({ ...first, runId: secondRunId }), {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );

    expect(secondResponse.body).toStrictEqual(firstResponse.body);
  });

  it("returns INVALID_CONSENT_CODE for an invalid code", async () => {
    const fixture = await seedSupportRun();
    const response = await accept(
      submitDeveloperSupport(zeroToken(fixture), {
        title: "Bug",
        description: "Something broke",
        consentCode: "ZZZZ",
      }),
      [400],
    );

    expect(response.body.error.code).toBe("INVALID_CONSENT_CODE");
  });

  it("submits a diagnostic bundle with a valid consent code", async () => {
    const fixture = await seedSupportRun();
    const token = zeroToken(fixture);
    const consent = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );

    const response = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
        consentCode: requireConsentCode(consent.body),
      }),
      [200],
    );

    expect(requireReference(response.body)).toMatch(/^ds-[a-f0-9]{8}$/);
    const putInput = putObjectInput();
    expect(putInput.Key).toContain("developer-support/");
  });
});
