import { randomUUID } from "node:crypto";

import AdmZip from "adm-zip";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { beforeEach, expect } from "vitest";
import { zeroDeveloperSupportContract } from "@vm0/api-contracts/contracts/zero-developer-support";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
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

const PLAIN_API_URL = "https://core-api.uk.plain.com/graphql/v1";

interface DeveloperSupportFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly runId: string;
}

interface RunSeedOptions {
  readonly status?: string;
  readonly prompt?: string;
  readonly createdAt?: Date;
  readonly continuedFromSessionId?: string | null;
  readonly result?: Record<string, unknown> | null;
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

function uploadedZip(): AdmZip {
  const body = putObjectInput().Body;
  if (!Buffer.isBuffer(body)) {
    throw new Error("expected ZIP upload body to be a Buffer");
  }
  return new AdmZip(body);
}

function zipText(zip: AdmZip, name: string): string {
  const entry = zip.getEntry(name);
  if (!entry) {
    throw new Error(`expected ZIP entry ${name}`);
  }
  return entry.getData().toString("utf8");
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
      status: options.status ?? "running",
      prompt: options.prompt,
      createdAt: options.createdAt,
      continuedFromSessionId: options.continuedFromSessionId,
      result: options.result,
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

  it("accepts a consent code from a different run in the same session", async () => {
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

    const consent = await accept(
      submitDeveloperSupport(zeroToken(first), {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );

    const response = await accept(
      submitDeveloperSupport(zeroToken({ ...first, runId: secondRunId }), {
        title: "Bug",
        description: "Something broke",
        consentCode: requireConsentCode(consent.body),
      }),
      [200],
    );

    expect(requireReference(response.body)).toMatch(/^ds-[a-f0-9]{8}$/);
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

  it("falls back to the current runId when a run has no session", async () => {
    const fixture = await seedSupportRun({ continuedFromSessionId: null });
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
    const agentEventsQuery = context.mocks.axiom.query.mock.calls
      .map(([apl]) => {
        return String(apl);
      })
      .find((apl) => {
        return apl.includes("agent-run-events") && apl.includes("runId in");
      });
    expect(agentEventsQuery).toContain(fixture.runId);
  });

  it("includes the user prompt in chat-history.jsonl", async () => {
    const fixture = await seedSupportRun({ prompt: "Inspect the deployment" });
    const token = zeroToken(fixture);
    const consent = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );

    await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
        consentCode: requireConsentCode(consent.body),
      }),
      [200],
    );

    const lines = zipText(uploadedZip(), "chat-history.jsonl")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        return JSON.parse(line) as {
          readonly eventType: string;
          readonly eventData: {
            readonly role?: string;
            readonly content?: string;
          };
          readonly sequenceNumber: number;
        };
      });
    const promptEvent = lines.find((event) => {
      return event.eventType === "user_prompt";
    });

    expect(promptEvent?.eventData.role).toBe("user");
    expect(promptEvent?.eventData.content).toBe("Inspect the deployment");
    expect(promptEvent?.sequenceNumber).toBe(-1);
  });

  it("collects prompts from all runs in a multi-run session", async () => {
    const sessionId = randomUUID();
    const first = await seedSupportRun({
      status: "completed",
      prompt: "First prompt",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      result: { agentSessionId: sessionId },
    });
    const { runId: secondRunId } = await store.set(
      seedRun$,
      {
        orgId: first.orgId,
        userId: first.userId,
        composeId: first.composeId,
        status: "running",
        prompt: "Second prompt",
        createdAt: new Date("2024-01-01T01:00:00Z"),
        continuedFromSessionId: sessionId,
      },
      context.signal,
    );
    const token = zeroToken({ ...first, runId: secondRunId });
    const consent = await accept(
      submitDeveloperSupport(token, {
        title: "Session bug",
        description: "Something broke",
      }),
      [200],
    );

    await accept(
      submitDeveloperSupport(token, {
        title: "Session bug",
        description: "Something broke",
        consentCode: requireConsentCode(consent.body),
      }),
      [200],
    );

    const lines = zipText(uploadedZip(), "chat-history.jsonl")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        return JSON.parse(line) as {
          readonly runId: string;
          readonly eventType: string;
          readonly eventData: { readonly content?: string };
        };
      });
    const promptEvents = lines.filter((event) => {
      return event.eventType === "user_prompt";
    });

    expect(
      promptEvents.map((event) => {
        return event.eventData.content;
      }),
    ).toStrictEqual(["First prompt", "Second prompt"]);
    expect(promptEvents[0]?.runId).toBe(first.runId);
    expect(promptEvents[1]?.runId).toBe(secondRunId);
  });

  it("succeeds when optional Axiom log queries fail", async () => {
    const fixture = await seedSupportRun();
    const token = zeroToken(fixture);
    const consent = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );
    context.mocks.axiom.query.mockRejectedValue(new Error("Axiom down"));

    const response = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
        consentCode: requireConsentCode(consent.body),
      }),
      [200],
    );

    expect(requireReference(response.body)).toMatch(/^ds-[a-f0-9]{8}$/);
  });

  it("creates a Plain support thread when PLAIN_API_KEY is configured", async () => {
    mockOptionalEnv("PLAIN_API_KEY", "plainkey_test_abc");
    let plainCallCount = 0;
    server.use(
      http.post(PLAIN_API_URL, () => {
        plainCallCount++;
        if (plainCallCount === 1) {
          return HttpResponse.json({
            data: {
              upsertTenant: {
                tenant: { id: "t1", externalId: "o1", name: "Org" },
                error: null,
              },
            },
          });
        }
        if (plainCallCount === 2) {
          return HttpResponse.json({
            data: {
              upsertCustomer: {
                customer: { id: "c1", externalId: "u1" },
                result: "CREATED",
                error: null,
              },
            },
          });
        }
        if (plainCallCount === 3) {
          return HttpResponse.json({
            data: {
              createThread: {
                thread: { id: "th1", externalId: "ds-ref1" },
                error: null,
              },
            },
          });
        }
        return HttpResponse.json({
          data: {
            createThreadEvent: { threadEvent: { id: "ev1" }, error: null },
          },
        });
      }),
    );
    const fixture = await seedSupportRun();
    const token = zeroToken(fixture);
    const consent = await accept(
      submitDeveloperSupport(token, {
        title: "Plain route test",
        description: "Something broke",
      }),
      [200],
    );

    const response = await accept(
      submitDeveloperSupport(token, {
        title: "Plain route test",
        description: "Something broke",
        consentCode: requireConsentCode(consent.body),
      }),
      [200],
    );

    expect(requireReference(response.body)).toMatch(/^ds-[a-f0-9]{8}$/);
    expect(plainCallCount).toBe(4);
  });
});
