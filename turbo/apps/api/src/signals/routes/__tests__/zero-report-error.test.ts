import { randomUUID } from "node:crypto";

import AdmZip from "adm-zip";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { beforeEach, expect } from "vitest";
import type { AxiomNetworkEvent } from "@vm0/api-contracts/contracts/runs";
import { zeroReportErrorContract } from "@vm0/api-contracts/contracts/zero-report-error";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const PLAIN_API_URL = "https://core-api.uk.plain.com/graphql/v1";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

interface ReportRunFixture extends UsageInsightFixture {
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

function zipEntryNames(zip: AdmZip): string[] {
  return zip.getEntries().map((entry) => {
    return entry.entryName;
  });
}

const networkBodyUtf8Encoding = ["utf", "8"].join("-") as NonNullable<
  AxiomNetworkEvent["request_body_encoding"]
>;

function activityLogJson(zip: AdmZip): Record<string, unknown> {
  const activityLogEntry = zip.getEntries().find((entry) => {
    return entry.entryName.startsWith("activity-log-");
  });
  if (!activityLogEntry) {
    throw new Error("expected activity log entry");
  }
  return JSON.parse(activityLogEntry.getData().toString("utf8")) as Record<
    string,
    unknown
  >;
}

async function seedReportRun(
  options: RunSeedOptions = {},
): Promise<ReportRunFixture> {
  const fixture = await track(
    store.set(seedUsageInsightFixture$, undefined, context.signal),
  );
  const { composeId } = await store.set(
    seedCompose$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      displayName: "Report Agent",
    },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId,
      status: options.status ?? "failed",
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
  return setupApp({ context })(zeroReportErrorContract);
}

function submitReport(body: {
  readonly runId: string;
  readonly title: string;
  readonly description?: string;
}) {
  return client().submit({
    headers: { authorization: "Bearer clerk-session" },
    body,
  });
}

beforeEach(() => {
  context.mocks.axiom.query.mockResolvedValue([]);
  context.mocks.s3.send.mockResolvedValue({});
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.com/diagnostic-report.zip?sig=test",
  );
  mockOptionalEnv("PLAIN_API_KEY", undefined);
});

describe("POST /api/zero/report-error", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      client().submit({
        headers: {},
        body: { runId: randomUUID(), title: "Bug" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("submits an error report for a failed run", async () => {
    const fixture = await seedReportRun();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      submitReport({
        runId: fixture.runId,
        title: "Run failed",
        description: "Something went wrong",
      }),
      [200],
    );

    expect(response.body.reference).toMatch(/^er-[a-f0-9]{8}$/);
    expect(putObjectInput().ContentType).toBe("application/zip");
  });

  it("writes title-only description when description is omitted", async () => {
    const fixture = await seedReportRun();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      submitReport({
        runId: fixture.runId,
        title: "Run crashed",
      }),
      [200],
    );

    expect(response.body.reference).toMatch(/^er-[a-f0-9]{8}$/);
    expect(zipText(uploadedZip(), "description.md")).toBe("# Run crashed");
  });

  it("returns 400 for a non-existent run", async () => {
    const fixture = await seedReportRun();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      submitReport({
        runId: randomUUID(),
        title: "Bug",
        description: "Desc",
      }),
      [400],
    );

    expect(response.body.error.code).toBe("RUN_NOT_FOUND");
  });

  it("returns 400 when runId is not a valid UUID", async () => {
    const fixture = await seedReportRun();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      submitReport({
        runId: "2b9b2303",
        title: "Bug",
        description: "Desc",
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when title is empty", async () => {
    const fixture = await seedReportRun();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().submit({
        headers: { authorization: "Bearer clerk-session" },
        body: { runId: fixture.runId, title: "" },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 for a non-failed run", async () => {
    const fixture = await seedReportRun({ status: "completed" });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      submitReport({
        runId: fixture.runId,
        title: "Bug",
        description: "Desc",
      }),
      [400],
    );

    expect(response.body.error.code).toBe("RUN_NOT_FAILED");
  });

  it("returns 403 for a run in a different org", async () => {
    const ownedFixture = await seedReportRun();
    const otherFixture = await seedReportRun();
    mocks.clerk.session(ownedFixture.userId, ownedFixture.orgId);

    const response = await accept(
      submitReport({
        runId: otherFixture.runId,
        title: "Bug",
        description: "Desc",
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("uploads a ZIP with expected diagnostic entries and description content", async () => {
    const fixture = await seedReportRun({ prompt: "Deploy the service" });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      submitReport({
        runId: fixture.runId,
        title: "GitHub connector 403",
        description: "Connector connected but API returns 403 on push",
      }),
      [200],
    );

    const input = putObjectInput();
    expect(String(input.Key)).toContain("error-reports/");
    expect(String(input.Key)).toContain(fixture.orgId);
    expect(String(input.Key)).toMatch(/er-[a-f0-9]{8}\.zip$/);

    const zip = uploadedZip();
    const entryNames = zipEntryNames(zip);
    expect(entryNames).toStrictEqual(
      expect.arrayContaining([
        "manifest.json",
        "description.md",
        "chat-history.jsonl",
        "environment.json",
        "connectors.json",
        "agent-config.json",
      ]),
    );
    expect(
      entryNames.some((entryName) => {
        return entryName.startsWith("activity-log-");
      }),
    ).toBeTruthy();
    expect(zipText(zip, "description.md")).toContain("# GitHub connector 403");
    expect(zipText(zip, "description.md")).toContain(
      "Connector connected but API returns 403 on push",
    );

    const environment = JSON.parse(zipText(zip, "environment.json")) as {
      readonly runId: string;
      readonly orgId: string;
      readonly status: string;
    };
    expect(environment).toMatchObject({
      runId: fixture.runId,
      orgId: fixture.orgId,
      status: "failed",
    });
  });

  it("includes run metadata in manifest and user prompt in chat history", async () => {
    const fixture = await seedReportRun({ prompt: "Deploy the service" });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      submitReport({ runId: fixture.runId, title: "Deploy failed" }),
      [200],
    );

    const zip = uploadedZip();
    const manifest = JSON.parse(zipText(zip, "manifest.json")) as {
      readonly reference: string;
      readonly userId: string;
      readonly orgId: string;
      readonly runId: string;
      readonly createdAt: string;
    };
    expect(manifest).toMatchObject({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: fixture.runId,
    });
    expect(manifest.reference).toMatch(/^er-[a-f0-9]{8}$/);
    expect(manifest.createdAt).toBeTruthy();

    const lines = zipText(zip, "chat-history.jsonl")
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
    expect(promptEvent?.eventData.content).toBe("Deploy the service");
    expect(promptEvent?.sequenceNumber).toBe(-1);
  });

  it("excludes optional system and network logs when Axiom returns no data", async () => {
    const fixture = await seedReportRun();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(submitReport({ runId: fixture.runId, title: "Bug" }), [200]);

    const entryNames = zipEntryNames(uploadedZip());
    expect(entryNames).not.toContain("system-log.txt");
    expect(entryNames).not.toContain("network-log.jsonl");
  });

  it("includes agent, system, and network logs when Axiom returns data", async () => {
    const fixture = await seedReportRun({ prompt: "Inspect outbound request" });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const networkEntry = {
      _time: "2026-04-28T07:00:00.123Z",
      runId: fixture.runId,
      userId: fixture.userId,
      type: "http",
      action: "ALLOW",
      host: "api.github.com",
      port: 443,
      method: "POST",
      url: "https://api.github.com/repos/vm0-ai/vm0",
      status: 201,
      latency_ms: 123,
      request_size: 456,
      response_size: 789,
      dns_event: "reply",
      dns_query_type: "A",
      dns_result: "140.82.121.4",
      dns_serial: "42",
      firewall_base: "https://api.github.com",
      firewall_name: "github",
      firewall_permission: "repos:write",
      firewall_rule_match: "POST /repos/{owner}/{repo}",
      firewall_params: { owner: "vm0-ai", repo: "vm0" },
      firewall_billable: true,
      firewall_error: "permission denied",
      auth_resolved_secrets: ["GITHUB_TOKEN"],
      auth_refreshed_connectors: ["github"],
      auth_refreshed_secrets: ["GITHUB_TOKEN"],
      auth_cache_hit: false,
      auth_url_rewrite: true,
      error: "upstream failure",
      request_headers: { "content-type": "application/json" },
      request_body: '{"hello":"world"}',
      request_body_encoding: networkBodyUtf8Encoding,
      request_body_truncated: false,
      response_headers: { "x-request-id": "req-1" },
      response_body: '{"ok":true}',
      response_body_encoding: networkBodyUtf8Encoding,
      response_body_truncated: false,
    } satisfies AxiomNetworkEvent;

    context.mocks.axiom.query.mockImplementation((...args: unknown[]) => {
      const apl = String(args[0]);
      if (apl.includes("agent-run-events")) {
        return Promise.resolve([
          {
            runId: fixture.runId,
            eventType: "assistant",
            eventData: { message: "Starting deploy" },
            _time: "2024-01-01T00:01:00Z",
            sequenceNumber: 1,
          },
        ]);
      }
      if (apl.includes("sandbox-telemetry-system")) {
        return Promise.resolve([
          { log: "booting sandbox\n" },
          { log: "ready\n" },
        ]);
      }
      if (apl.includes("sandbox-telemetry-network")) {
        return Promise.resolve([networkEntry]);
      }
      return Promise.resolve([]);
    });

    await accept(submitReport({ runId: fixture.runId, title: "Bug" }), [200]);

    const zip = uploadedZip();
    expect(zipText(zip, "system-log.txt")).toBe("booting sandbox\nready\n");
    const networkLog = JSON.parse(zipText(zip, "network-log.jsonl")) as {
      readonly method: string;
      readonly firewall_action?: string;
    };
    expect(networkLog.method).toBe("POST");

    const activityLogEntry = zip.getEntries().find((entry) => {
      return entry.entryName.startsWith("activity-log-");
    });
    if (!activityLogEntry) {
      throw new Error("expected activity log entry");
    }
    const activityLog = JSON.parse(
      activityLogEntry.getData().toString("utf8"),
    ) as { readonly networkLogs?: readonly Record<string, unknown>[] };
    expect(activityLog.networkLogs?.[0]).toStrictEqual({
      timestamp: "2026-04-28T07:00:00.123Z",
      type: "http",
      action: "ALLOW",
      host: "api.github.com",
      port: 443,
      method: "POST",
      url: "https://api.github.com/repos/vm0-ai/vm0",
      status: 201,
      latency_ms: 123,
      request_size: 456,
      response_size: 789,
      dns_event: "reply",
      dns_query_type: "A",
      dns_result: "140.82.121.4",
      dns_serial: "42",
      firewall_base: "https://api.github.com",
      firewall_name: "github",
      firewall_permission: "repos:write",
      firewall_rule_match: "POST /repos/{owner}/{repo}",
      firewall_params: { owner: "vm0-ai", repo: "vm0" },
      firewall_billable: true,
      firewall_error: "permission denied",
      auth_resolved_secrets: ["GITHUB_TOKEN"],
      auth_refreshed_connectors: ["github"],
      auth_refreshed_secrets: ["GITHUB_TOKEN"],
      auth_cache_hit: false,
      auth_url_rewrite: true,
      error: "upstream failure",
      request_headers: { "content-type": "application/json" },
      request_body: '{"hello":"world"}',
      request_body_encoding: networkBodyUtf8Encoding,
      request_body_truncated: false,
      response_headers: { "x-request-id": "req-1" },
      response_body: '{"ok":true}',
      response_body_encoding: networkBodyUtf8Encoding,
      response_body_truncated: false,
    });
  });

  it("includes run context when a same-org non-owner submits the report", async () => {
    const fixture = await seedReportRun({ prompt: "Inspect deployment" });
    mocks.clerk.session(randomUUID(), fixture.orgId);

    context.mocks.axiom.query.mockImplementation((...args: unknown[]) => {
      const apl = String(args[0]);
      if (apl.includes("run-context")) {
        return Promise.resolve([
          {
            runId: fixture.runId,
            sessionId: "session-123",
            environment: { NODE_ENV: "production" },
            firewalls: [],
            volumes: [],
          },
        ]);
      }
      return Promise.resolve([]);
    });

    await accept(
      submitReport({ runId: fixture.runId, title: "Same org report" }),
      [200],
    );

    expect(activityLogJson(uploadedZip()).context).toMatchObject({
      runId: fixture.runId,
      sessionId: "session-123",
      environment: { NODE_ENV: "production" },
    });
  });

  it("collects prompts from all runs in a multi-run session", async () => {
    const sessionId = randomUUID();
    const first = await seedReportRun({
      status: "completed",
      prompt: "First prompt",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      result: { agentSessionId: sessionId },
    });
    const { runId: failedRunId } = await store.set(
      seedRun$,
      {
        orgId: first.orgId,
        userId: first.userId,
        composeId: first.composeId,
        status: "failed",
        prompt: "Second prompt",
        createdAt: new Date("2024-01-01T01:00:00Z"),
        continuedFromSessionId: sessionId,
      },
      context.signal,
    );
    mocks.clerk.session(first.userId, first.orgId);

    await accept(
      submitReport({ runId: failedRunId, title: "Session failed" }),
      [200],
    );

    const lines = zipText(uploadedZip(), "chat-history.jsonl")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        return JSON.parse(line) as {
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

    const agentEventsQuery = context.mocks.axiom.query.mock.calls
      .map(([apl]) => {
        return String(apl);
      })
      .find((apl) => {
        return apl.includes("agent-run-events") && apl.includes("runId in");
      });
    expect(agentEventsQuery).toContain(first.runId);
    expect(agentEventsQuery).toContain(failedRunId);
  });

  it("succeeds when optional Axiom log queries fail", async () => {
    const fixture = await seedReportRun();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.axiom.query.mockRejectedValue(new Error("Axiom down"));

    const response = await accept(
      submitReport({ runId: fixture.runId, title: "Bug" }),
      [200],
    );

    expect(response.body.reference).toMatch(/^er-[a-f0-9]{8}$/);
    const entryNames = uploadedZip()
      .getEntries()
      .map((entry) => {
        return entry.entryName;
      });
    expect(entryNames).not.toContain("system-log.txt");
    expect(entryNames).not.toContain("network-log.jsonl");
  });

  it("keeps the bundle successful when one run activity log fails", async () => {
    const sessionId = randomUUID();
    const first = await seedReportRun({
      status: "completed",
      prompt: "First prompt",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      result: { agentSessionId: sessionId },
    });
    const { runId: failedRunId } = await store.set(
      seedRun$,
      {
        orgId: first.orgId,
        userId: first.userId,
        composeId: first.composeId,
        status: "failed",
        prompt: "Second prompt",
        createdAt: new Date("2024-01-01T01:00:00Z"),
        continuedFromSessionId: sessionId,
      },
      context.signal,
    );
    mocks.clerk.session(first.userId, first.orgId);

    context.mocks.axiom.query.mockImplementation((...args: unknown[]) => {
      const apl = String(args[0]);
      if (
        apl.includes(`runId == "${first.runId}"`) &&
        apl.includes("sandbox-telemetry-network")
      ) {
        return Promise.resolve(null);
      }
      return Promise.resolve([]);
    });

    const response = await accept(
      submitReport({ runId: failedRunId, title: "Resilience test" }),
      [200],
    );

    expect(response.body.reference).toMatch(/^er-[a-f0-9]{8}$/);
    const activityLogEntries = uploadedZip()
      .getEntries()
      .filter((entry) => {
        return entry.entryName.startsWith("activity-log-");
      });
    expect(activityLogEntries).toHaveLength(2);

    const contents = activityLogEntries.map((entry) => {
      return JSON.parse(entry.getData().toString("utf8")) as {
        readonly ok?: boolean;
        readonly runId?: string;
        readonly error?: string;
      };
    });
    const erroredEntry = contents.find((entry) => {
      return entry.ok === false;
    });
    expect(erroredEntry?.runId).toBe(first.runId);
    expect(typeof erroredEntry?.error).toBe("string");
  });

  it("returns sanitized 500 when ZIP upload fails", async () => {
    const fixture = await seedReportRun();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockRejectedValueOnce(new Error("S3 upload failed"));

    const response = await accept(
      submitReport({ runId: fixture.runId, title: "Bug" }),
      [500],
    );

    expect(response.body.error).toStrictEqual({
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    });
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
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
                thread: { id: "th1", externalId: "er-ref1" },
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

    const fixture = await seedReportRun();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      submitReport({ runId: fixture.runId, title: "Plain route test" }),
      [200],
    );

    expect(response.body.reference).toMatch(/^er-[a-f0-9]{8}$/);
    expect(plainCallCount).toBe(4);
  });
});
