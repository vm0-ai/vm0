import { randomUUID } from "node:crypto";

import { zeroDeveloperSupportContract } from "@vm0/api-contracts/contracts/zero-developer-support";
import AdmZip from "adm-zip";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, it } from "vitest";

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

// BDD migration of the legacy `zero-developer-support.test.ts`. The 13
// legacy `it()`s collapse into 5 BDD `it()`s:
// (1) auth + not-found chain (401 unauth → 403 no run scope → 400
// RUN_NOT_FOUND),
// (2) single-run consent chain (200 deterministic consent code → 200
// same code on repeat → 400 INVALID_CONSENT_CODE → 200 valid
// consent + reference),
// (3) cross-run session chain (200 same consent code across runs
// in same session → 200 accept consent from other run → 200 with
// reference),
// (4) bundle content chain (200 no-session runId fallback → 200
// chat-history includes user prompt → 200 multi-run session
// collects all prompts),
// (5) optional dependency chain (200 succeeds when Axiom query
// fails → 200 creates Plain thread when PLAIN_API_KEY configured).

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

function findAllZipUploads(): readonly Record<string, unknown>[] {
  return context.mocks.s3.send.mock.calls
    .map(([command]) => {
      return commandInput(command);
    })
    .filter((input) => {
      return (
        input.Body !== undefined && input.ContentType === "application/zip"
      );
    });
}

function putObjectInput(): Record<string, unknown> {
  const [input] = findAllZipUploads();
  if (!input) {
    throw new Error("expected S3 PutObjectCommand");
  }
  return input;
}

function zipAt(index: number): Record<string, unknown> {
  const all = findAllZipUploads();
  const input = all[index];
  if (!input) {
    throw new Error(
      `expected at least ${index + 1} S3 PutObjectCommand(s), found ${all.length}`,
    );
  }
  return input;
}

function uploadedZipAt(index: number): AdmZip {
  const body = zipAt(index).Body;
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

describe("BDD POST /api/zero/developer-support — auth + not-found chain", () => {
  it("gwt-wt-wt: 401 unauth → 403 no run scope → 400 RUN_NOT_FOUND", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      submitDeveloperSupport(undefined, {
        title: "Bug",
        description: "Something broke",
      }),
      [401],
    );
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a zero token with no runId/orgId (no run scope).

    // When + Then: 403.
    const unscopedToken = zeroToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: randomUUID(),
    });
    const unscoped = await accept(
      submitDeveloperSupport(unscopedToken, {
        title: "Bug",
        description: "Something broke",
      }),
      [403],
    );
    expect(unscoped.body).toStrictEqual({
      error: {
        message: "This endpoint requires a zero token with runId and orgId",
        code: "FORBIDDEN",
      },
    });

    // Given: a zero token for a runId that does not exist.

    // When + Then: 400 — RUN_NOT_FOUND.
    const fixture = await seedSupportRun();
    const missingToken = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: randomUUID(),
    });
    const missing = await accept(
      submitDeveloperSupport(missingToken, {
        title: "Bug",
        description: "Something broke",
      }),
      [400],
    );
    expect(missing.body.error.code).toBe("RUN_NOT_FOUND");
  });
});

describe("BDD POST /api/zero/developer-support — single-run consent chain", () => {
  it("gwt-wt-wt: 200 deterministic consent → 200 same code on repeat → 400 INVALID_CONSENT_CODE → 200 valid consent + reference", async () => {
    // Given: a fresh support run.

    // When + Then: 200 — first call returns a 4-char hex consent
    // code; a second call with the same fixture returns an
    // identical response (deterministic consent).
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

    // Given: the same fresh run + a bogus consent code.

    // When + Then: 400 — INVALID_CONSENT_CODE.
    const invalid = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
        consentCode: "ZZZZ",
      }),
      [400],
    );
    expect(invalid.body.error.code).toBe("INVALID_CONSENT_CODE");

    // Given: the same fixture + the valid consent code from
    // the first step.

    // When + Then: 200 — submit succeeds and returns a
    // `ds-` reference; the uploaded ZIP is keyed under
    // `developer-support/`.
    const submitted = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
        consentCode: requireConsentCode(first.body),
      }),
      [200],
    );
    expect(requireReference(submitted.body)).toMatch(/^ds-[a-f0-9]{8}$/);
    expect(putObjectInput().Key).toContain("developer-support/");
  });
});

describe("BDD POST /api/zero/developer-support — cross-run session chain", () => {
  it("gwt-wt-wt: 200 same consent across runs in same session → 200 accept consent from other run → 200 with reference", async () => {
    // Given: a session (continuedFromSessionId) with a first
    // run + a second run sharing the same session.

    // When + Then: 200 — both runs produce the same consent
    // code response (the consent is keyed to the session,
    // not the run).
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

    // Given: the same session + the consent code from the
    // first run + a request from the second run.

    // When + Then: 200 — the consent code is accepted from
    // the sibling run and a `ds-` reference is returned.
    const accepted = await accept(
      submitDeveloperSupport(zeroToken({ ...first, runId: secondRunId }), {
        title: "Bug",
        description: "Something broke",
        consentCode: requireConsentCode(firstResponse.body),
      }),
      [200],
    );
    expect(requireReference(accepted.body)).toMatch(/^ds-[a-f0-9]{8}$/);
  });
});

describe("BDD POST /api/zero/developer-support — bundle content chain", () => {
  it("gwt-wt-wt: 200 no-session runId fallback → 200 chat-history includes user prompt → 200 multi-run session collects all prompts", async () => {
    // Given: a support run with continuedFromSessionId=null.

    // When + Then: 200 — consent flow succeeds + the
    // agent-run-events Axiom query references the
    // standalone runId (no session to expand into).
    const noSessionFixture = await seedSupportRun({
      continuedFromSessionId: null,
    });
    const noSessionToken = zeroToken(noSessionFixture);
    const noSessionConsent = await accept(
      submitDeveloperSupport(noSessionToken, {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );
    const noSessionSubmitted = await accept(
      submitDeveloperSupport(noSessionToken, {
        title: "Bug",
        description: "Something broke",
        consentCode: requireConsentCode(noSessionConsent.body),
      }),
      [200],
    );
    expect(requireReference(noSessionSubmitted.body)).toMatch(
      /^ds-[a-f0-9]{8}$/,
    );
    expect(putObjectInput().Key).toContain("developer-support/");
    const agentEventsQuery = context.mocks.axiom.query.mock.calls
      .map(([apl]) => {
        return String(apl);
      })
      .find((apl) => {
        return apl.includes("agent-run-events") && apl.includes("runId in");
      });
    expect(agentEventsQuery).toContain(noSessionFixture.runId);

    // Given: a support run with a custom prompt.

    // When + Then: 200 — the chat-history.jsonl entry inside
    // the uploaded ZIP records the user_prompt event with
    // sequence number -1 and the run's prompt.
    const promptFixture = await seedSupportRun({
      prompt: "Inspect the deployment",
    });
    const promptToken = zeroToken(promptFixture);
    const promptConsent = await accept(
      submitDeveloperSupport(promptToken, {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );
    await accept(
      submitDeveloperSupport(promptToken, {
        title: "Bug",
        description: "Something broke",
        consentCode: requireConsentCode(promptConsent.body),
      }),
      [200],
    );
    const lines = zipText(uploadedZipAt(1), "chat-history.jsonl")
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

    // Given: a multi-run session with two runs that have
    // different prompts and the first run's result points at
    // a shared agentSessionId.

    // When + Then: 200 — chat-history.jsonl carries the
    // user_prompt events from BOTH runs, in run order
    // (first run first).
    const multiSessionId = randomUUID();
    const first = await seedSupportRun({
      status: "completed",
      prompt: "First prompt",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      result: { agentSessionId: multiSessionId },
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
        continuedFromSessionId: multiSessionId,
      },
      context.signal,
    );
    const multiToken = zeroToken({ ...first, runId: secondRunId });
    const multiConsent = await accept(
      submitDeveloperSupport(multiToken, {
        title: "Session bug",
        description: "Something broke",
      }),
      [200],
    );
    await accept(
      submitDeveloperSupport(multiToken, {
        title: "Session bug",
        description: "Something broke",
        consentCode: requireConsentCode(multiConsent.body),
      }),
      [200],
    );
    const multiLines = zipText(uploadedZipAt(2), "chat-history.jsonl")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        return JSON.parse(line) as {
          readonly runId: string;
          readonly eventType: string;
          readonly eventData: { readonly content?: string };
        };
      });
    const promptEvents = multiLines.filter((event) => {
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
});

describe("BDD POST /api/zero/developer-support — optional dependency chain", () => {
  it("gwt-wt-wt: 200 succeeds when Axiom query fails → 200 creates Plain thread when PLAIN_API_KEY configured", async () => {
    // Given: a fresh support run + a consent code.

    // When + Then: 200 — the submit succeeds (returns a
    // `ds-` reference) even after the Axiom query mock is
    // rejected (Axiom is optional).
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
    const noAxiom = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
        consentCode: requireConsentCode(consent.body),
      }),
      [200],
    );
    expect(requireReference(noAxiom.body)).toMatch(/^ds-[a-f0-9]{8}$/);

    // Given: PLAIN_API_KEY configured + a Plain MSW handler
    // that handles upsertTenant, upsertCustomer, createThread,
    // and createThreadEvent in sequence.

    // When + Then: 200 — submit succeeds and the Plain
    // handler is called four times (one for each of the
    // four GraphQL operations).
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
    const plainFixture = await seedSupportRun();
    const plainToken = zeroToken(plainFixture);
    const plainConsent = await accept(
      submitDeveloperSupport(plainToken, {
        title: "Plain route test",
        description: "Something broke",
      }),
      [200],
    );
    const plain = await accept(
      submitDeveloperSupport(plainToken, {
        title: "Plain route test",
        description: "Something broke",
        consentCode: requireConsentCode(plainConsent.body),
      }),
      [200],
    );
    expect(requireReference(plain.body)).toMatch(/^ds-[a-f0-9]{8}$/);
    expect(plainCallCount).toBe(4);
  });
});
