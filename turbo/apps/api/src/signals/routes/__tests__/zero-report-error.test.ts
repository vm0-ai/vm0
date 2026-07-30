import { createHash, randomUUID } from "node:crypto";

import AdmZip from "adm-zip";
import { HttpResponse, http } from "msw";
import { beforeEach, expect } from "vitest";
import type { AxiomNetworkEvent } from "@vm0/api-contracts/contracts/runs";
import { zeroReportErrorContract } from "@vm0/api-contracts/contracts/zero-report-error";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createRunsApi,
  zeroBackedDirectRunRequest,
} from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const PLAIN_API_URL = "https://core-api.uk.plain.com/graphql/v1";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface ReportSeed {
  readonly actor: ApiTestUser;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

interface ReportRun {
  readonly runId: string;
  readonly sessionId: string;
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

function mockSessionHistoryBlob(hash: string, history: string): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = (command as { readonly input?: { readonly Key?: string } })
      .input;
    if (input?.Key === `blobs/${hash}.blob`) {
      if (
        (command as { readonly constructor?: { readonly name?: string } })
          .constructor?.name === "HeadObjectCommand"
      ) {
        return Promise.resolve({
          ContentLength: Buffer.byteLength(history, "utf8"),
        });
      }
      return Promise.resolve({
        Body: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from(history, "utf8");
          },
        },
      });
    }
    return Promise.resolve({});
  });
}

async function seedReportActor(): Promise<ReportSeed> {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Report fixtures require an org-scoped actor");
  }
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Report Agent",
    visibility: "private",
  });
  return {
    actor,
    orgId: actor.orgId,
    userId: actor.userId,
    agentId: agent.agentId,
  };
}

async function createReportRun(
  seed: ReportSeed,
  options: { readonly prompt?: string; readonly sessionId?: string } = {},
): Promise<ReportRun> {
  const api = createRunsApi(context);
  const prompt = options.prompt ?? "Report precondition";
  if (options.sessionId === undefined) {
    const run = await api.createDirectRun(
      seed.actor,
      zeroBackedDirectRunRequest({ agentId: seed.agentId, prompt }),
    );
    return { runId: run.runId, sessionId: run.sessionId };
  }
  const run = await api.createDirectRun(
    seed.actor,
    zeroBackedDirectRunRequest({
      agentId: seed.agentId,
      prompt,
      sessionId: options.sessionId,
    }),
  );
  return { runId: run.runId, sessionId: run.sessionId };
}

async function failRun(seed: ReportSeed, runId: string): Promise<void> {
  const api = createRunsApi(context);
  const webhooks = createWebhookCallbackApi(context);
  await webhooks.requestAgentComplete(
    { runId, exitCode: 1, error: "report precondition failure" },
    {
      authorization: `Bearer ${api.sandboxTokenForRun(seed.actor, runId)}`,
    },
    [200],
  );
}

/**
 * Completes the run through the sandbox checkpoint + complete webhooks so its
 * result records the agent session (result.agentSessionId), matching runs
 * that finished a real session.
 */
async function completeRunWithSession(
  seed: ReportSeed,
  run: ReportRun,
): Promise<void> {
  const api = createRunsApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const sandboxHeaders = {
    authorization: `Bearer ${api.sandboxTokenForRun(seed.actor, run.runId)}`,
  };
  const history = `report session history ${run.runId}`;
  const historyHash = createHash("sha256").update(history).digest("hex");
  mockSessionHistoryBlob(historyHash, history);
  await webhooks.requestAgentCheckpoint(
    {
      runId: run.runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `report-cli-${run.runId}`,
      cliAgentSessionHistoryHash: historyHash,
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    { runId: run.runId, exitCode: 0, lastEventSequence: 0 },
    sandboxHeaders,
    [200],
  );
}

interface ReportRunFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
}

async function seedFailedReportRun(
  options: { readonly prompt?: string } = {},
): Promise<ReportRunFixture> {
  const seed = await seedReportActor();
  const run = await createReportRun(seed, { prompt: options.prompt });
  await failRun(seed, run.runId);
  return { orgId: seed.orgId, userId: seed.userId, runId: run.runId };
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
    const fixture = await seedFailedReportRun();
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
    const fixture = await seedFailedReportRun();
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
    const fixture = await seedFailedReportRun();
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
    const fixture = await seedFailedReportRun();
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
    const fixture = await seedFailedReportRun();
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
    const seed = await seedReportActor();
    const run = await createReportRun(seed);
    await completeRunWithSession(seed, run);
    mocks.clerk.session(seed.userId, seed.orgId);

    const response = await accept(
      submitReport({
        runId: run.runId,
        title: "Bug",
        description: "Desc",
      }),
      [400],
    );

    expect(response.body.error.code).toBe("RUN_NOT_FAILED");
  });

  it("returns 403 for a run in a different org", async () => {
    const ownedFixture = await seedFailedReportRun();
    const otherFixture = await seedFailedReportRun();
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
    const fixture = await seedFailedReportRun({
      prompt: "Deploy the service",
    });
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
    const fixture = await seedFailedReportRun({
      prompt: "Deploy the service",
    });
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
    const fixture = await seedFailedReportRun();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(submitReport({ runId: fixture.runId, title: "Bug" }), [200]);

    const entryNames = zipEntryNames(uploadedZip());
    expect(entryNames).not.toContain("system-log.txt");
    expect(entryNames).not.toContain("network-log.jsonl");
  });

  it("includes agent, system, and network logs when Axiom returns data", async () => {
    const fixture = await seedFailedReportRun({
      prompt: "Inspect outbound request",
    });
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
      browser_user_agent: true,
      model_catalog_cache_status: "model_catalog_revalidated_200_same",
      model_catalog_cache_upstream_encoding: "br",
      model_catalog_cache_bypass_reason: "response_cache_control",
      model_catalog_cache_entry_age_ms: 61_000,
      model_catalog_cache_validation_latency_ms: 1700,
      model_catalog_cache_eviction_count: 1,
      model_catalog_prefetch_role: "completed_consumer",
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
      upstream_binding_reason: "connector_auth",
      upstream_binding_server_connected: false,
      upstream_binding_client_binding_count: 0,
      connector_diagnostic_type: "github",
      connector_route_reason: "connector_intent_required",
      connector_route_candidates: ["auditor", "primary"],
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
    const canonicalNetworkEntry = {
      ...networkEntry,
      _time: "2026-04-28T07:00:01.123Z",
      host: "api.slack.com",
      url: "https://api.slack.com/methods/auth.test",
      connector_diagnostic_slug: "slack",
      connector_diagnostic_type: undefined,
    } satisfies AxiomNetworkEvent;
    const conflictingNetworkEntry = {
      ...networkEntry,
      _time: "2026-04-28T07:00:02.123Z",
      host: "conflict.example.com",
      connector_diagnostic_slug: "github",
      connector_diagnostic_type: "gitlab",
    } satisfies AxiomNetworkEvent;
    const identityFreeNetworkEntry = {
      ...networkEntry,
      _time: "2026-04-28T07:00:03.123Z",
      host: "example.com",
      url: "https://example.com/health",
      connector_diagnostic_type: undefined,
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
        return Promise.resolve([
          networkEntry,
          canonicalNetworkEntry,
          conflictingNetworkEntry,
          identityFreeNetworkEntry,
        ]);
      }
      return Promise.resolve([]);
    });

    await accept(submitReport({ runId: fixture.runId, title: "Bug" }), [200]);

    const zip = uploadedZip();
    expect(zipText(zip, "system-log.txt")).toBe("booting sandbox\nready\n");
    const networkLogs = zipText(zip, "network-log.jsonl")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        return JSON.parse(line) as Record<string, unknown>;
      });
    expect(networkLogs).toStrictEqual([
      expect.objectContaining({
        _time: "2026-04-28T07:00:00.123Z",
        method: "POST",
        connector_diagnostic_slug: "github",
        connector_diagnostic_type: "github",
      }),
      expect.objectContaining({
        _time: "2026-04-28T07:00:01.123Z",
        host: "api.slack.com",
        connector_diagnostic_slug: "slack",
        connector_diagnostic_type: "slack",
      }),
      expect.objectContaining({
        _time: "2026-04-28T07:00:03.123Z",
        host: "example.com",
      }),
    ]);
    expect(networkLogs[2]).not.toHaveProperty("connector_diagnostic_slug");
    expect(networkLogs[2]).not.toHaveProperty("connector_diagnostic_type");

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
      browser_user_agent: true,
      model_catalog_cache_status: "model_catalog_revalidated_200_same",
      model_catalog_cache_upstream_encoding: "br",
      model_catalog_cache_bypass_reason: "response_cache_control",
      model_catalog_cache_entry_age_ms: 61_000,
      model_catalog_cache_validation_latency_ms: 1700,
      model_catalog_cache_eviction_count: 1,
      model_catalog_prefetch_role: "completed_consumer",
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
      upstream_binding_reason: "connector_auth",
      upstream_binding_server_connected: false,
      upstream_binding_client_binding_count: 0,
      connector_diagnostic_slug: "github",
      connector_diagnostic_type: "github",
      connector_route_reason: "connector_intent_required",
      connector_route_candidates: ["auditor", "primary"],
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
    expect(activityLog.networkLogs).toHaveLength(3);
    expect(activityLog.networkLogs?.[1]).toMatchObject({
      timestamp: "2026-04-28T07:00:01.123Z",
      host: "api.slack.com",
      connector_diagnostic_slug: "slack",
      connector_diagnostic_type: "slack",
    });
    expect(activityLog.networkLogs?.[2]).toMatchObject({
      timestamp: "2026-04-28T07:00:03.123Z",
      host: "example.com",
    });
    expect(activityLog.networkLogs?.[2]).not.toHaveProperty(
      "connector_diagnostic_slug",
    );
    expect(activityLog.networkLogs?.[2]).not.toHaveProperty(
      "connector_diagnostic_type",
    );
  });

  it("includes run context when a same-org non-owner submits the report", async () => {
    const fixture = await seedFailedReportRun({
      prompt: "Inspect deployment",
    });
    mocks.clerk.session(randomUUID(), fixture.orgId);

    context.mocks.axiom.query.mockImplementation((...args: unknown[]) => {
      const apl = String(args[0]);
      if (apl.includes("run-context")) {
        return Promise.resolve([
          {
            runId: fixture.runId,
            appendSystemPrompt: null,
            sessionId: "session-123",
            environmentEntries: [{ name: "NODE_ENV", value: "production" }],
            networkPolicyEntries: [
              {
                name: "github",
                policy: {
                  allow: ["repo-read"],
                  deny: [],
                  ask: [],
                  unknownPolicy: "allow",
                },
              },
            ],
            featureFlagEntries: [{ name: "lab", enabled: true }],
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

    const activityContext = activityLogJson(uploadedZip()).context as Record<
      string,
      unknown
    >;
    expect(activityContext).toMatchObject({
      runId: fixture.runId,
      appendSystemPrompt: null,
      sessionId: "session-123",
      environment: { NODE_ENV: "production" },
      networkPolicies: {
        github: {
          allow: ["repo-read"],
          deny: [],
          ask: [],
          unknownPolicy: "allow",
        },
      },
      featureFlags: { lab: true },
    });
    expect(activityContext).not.toHaveProperty("environmentEntries");
    expect(activityContext).not.toHaveProperty("networkPolicyEntries");
    expect(activityContext).not.toHaveProperty("featureFlagEntries");
  });

  it("collects prompts from all runs in a multi-run session", async () => {
    const seed = await seedReportActor();
    const first = await createReportRun(seed, { prompt: "First prompt" });
    await completeRunWithSession(seed, first);
    const second = await createReportRun(seed, {
      prompt: "Second prompt",
      sessionId: first.sessionId,
    });
    await failRun(seed, second.runId);
    mocks.clerk.session(seed.userId, seed.orgId);

    await accept(
      submitReport({ runId: second.runId, title: "Session failed" }),
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
    expect(agentEventsQuery).toContain(second.runId);
  });

  it("succeeds when optional Axiom log queries fail", async () => {
    const fixture = await seedFailedReportRun();
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
    const seed = await seedReportActor();
    const first = await createReportRun(seed, { prompt: "First prompt" });
    await completeRunWithSession(seed, first);
    const second = await createReportRun(seed, {
      prompt: "Second prompt",
      sessionId: first.sessionId,
    });
    await failRun(seed, second.runId);
    mocks.clerk.session(seed.userId, seed.orgId);

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
      submitReport({ runId: second.runId, title: "Resilience test" }),
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
    const fixture = await seedFailedReportRun();
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

    const fixture = await seedFailedReportRun();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      submitReport({ runId: fixture.runId, title: "Plain route test" }),
      [200],
    );

    expect(response.body.reference).toMatch(/^er-[a-f0-9]{8}$/);
    expect(plainCallCount).toBe(4);
  });
});
