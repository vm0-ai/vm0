import { describe, it, expect, beforeEach, vi } from "vitest";
import AdmZip from "adm-zip";
import { randomUUID } from "crypto";
import { HttpResponse } from "msw";
import { POST } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  createTestRunInDb,
  findTestOutboxItems,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { server } from "../../../../../src/mocks/server";
import { http } from "../../../../../src/__tests__/msw";
import { reloadEnv } from "../../../../../src/env";

const PLAIN_API_URL = "https://core-api.uk.plain.com/graphql/v1";

const URL = "http://localhost:3000/api/zero/report-error";
const context = testContext();

async function setupFailedRun(
  userId: string,
  options?: {
    prompt?: string;
    continuedFromSessionId?: string;
    createdAt?: Date;
    result?: Record<string, unknown>;
  },
) {
  const compose = await createTestCompose(`agent-${uniqueId("rpt")}`);
  const { runId } = await createTestRunInDb(userId, compose.composeId, {
    status: "failed",
    ...options,
  });
  return { runId, composeId: compose.composeId };
}

function postReportError(body: Record<string, unknown>) {
  return POST(
    createTestRequest(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/zero/report-error", () => {
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    context.setupMocks();
    userId = uniqueId("rpt-user");
    const slug = uniqueId("rpt-org");
    orgId = `org_mock_${userId}`;
    mockClerk({ userId, orgId, orgRole: "org:admin" });
    await createTestOrg(slug);
  });

  // -------------------------------------------------------------------------
  // Auth & validation
  // -------------------------------------------------------------------------

  it("should submit error report for a failed run", async () => {
    const { runId } = await setupFailedRun(userId);

    const response = await postReportError({
      runId,
      title: "Run failed",
      description: "Something went wrong",
    });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.reference).toBeDefined();
    expect(data.reference).toMatch(/^er-[a-f0-9]{8}$/);
  });

  it("should return 400 for non-existent run", async () => {
    const response = await postReportError({
      runId: randomUUID(),
      title: "Bug",
      description: "Desc",
    });
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error.code).toBe("RUN_NOT_FOUND");
  });

  it("should return 400 for non-failed run", async () => {
    const compose = await createTestCompose(`agent-${uniqueId("rpt")}`);
    const { runId } = await createTestRunInDb(userId, compose.composeId, {
      status: "completed",
    });

    const response = await postReportError({
      runId,
      title: "Bug",
      description: "Desc",
    });
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error.code).toBe("RUN_NOT_FAILED");
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await postReportError({
      runId: randomUUID(),
      title: "Bug",
      description: "Desc",
    });
    expect(response.status).toBe(401);
  });

  it("should return 403 for run in different org", async () => {
    // Create a run under a different user/org
    const otherUserId = uniqueId("rpt-other");
    const otherSlug = uniqueId("rpt-other-org");
    // Temporarily mock as other user to create the org and compose
    mockClerk({
      userId: otherUserId,
      orgId: `org_mock_${otherUserId}`,
      orgRole: "org:admin",
    });
    await createTestOrg(otherSlug);
    const { runId } = await setupFailedRun(otherUserId);

    // Switch back to original user
    mockClerk({ userId, orgId, orgRole: "org:admin" });

    const response = await postReportError({
      runId,
      title: "Bug",
      description: "Desc",
    });
    expect(response.status).toBe(403);

    const data = await response.json();
    expect(data.error.code).toBe("FORBIDDEN");
  });

  // -------------------------------------------------------------------------
  // Optional description
  // -------------------------------------------------------------------------

  it("should accept submission without description", async () => {
    const { runId } = await setupFailedRun(userId);

    const response = await postReportError({
      runId,
      title: "Run failed unexpectedly",
    });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.reference).toMatch(/^er-[a-f0-9]{8}$/);
  });

  // -------------------------------------------------------------------------
  // ZIP bundle content
  // -------------------------------------------------------------------------

  it("should include title and description in ZIP description.md", async () => {
    const { runId } = await setupFailedRun(userId);

    const response = await postReportError({
      runId,
      title: "GitHub connector 403",
      description: "Connector connected but API returns 403 on push",
    });
    expect(response.status).toBe(200);

    const zipBuffer = context.mocks.s3.uploadS3Buffer.mock
      .calls[0]![2] as Buffer;
    const zip = new AdmZip(zipBuffer);
    const descriptionMd = zip
      .getEntry("description.md")!
      .getData()
      .toString("utf-8");

    expect(descriptionMd).toContain("# GitHub connector 403");
    expect(descriptionMd).toContain(
      "Connector connected but API returns 403 on push",
    );
  });

  it("should write title-only description.md when description is omitted", async () => {
    const { runId } = await setupFailedRun(userId);

    const response = await postReportError({
      runId,
      title: "Run crashed",
    });
    expect(response.status).toBe(200);

    const zipBuffer = context.mocks.s3.uploadS3Buffer.mock
      .calls[0]![2] as Buffer;
    const zip = new AdmZip(zipBuffer);
    const descriptionMd = zip
      .getEntry("description.md")!
      .getData()
      .toString("utf-8");

    expect(descriptionMd).toBe("# Run crashed");
  });

  it("should include all expected files in ZIP", async () => {
    const { runId } = await setupFailedRun(userId);

    await postReportError({
      runId,
      title: "Bug",
      description: "Desc",
    });

    const zipBuffer = context.mocks.s3.uploadS3Buffer.mock
      .calls[0]![2] as Buffer;
    const zip = new AdmZip(zipBuffer);
    const entryNames = zip.getEntries().map((e) => {
      return e.entryName;
    });

    expect(entryNames).toContain("manifest.json");
    expect(entryNames).toContain("description.md");
    expect(entryNames).toContain("chat-history.jsonl");
    expect(entryNames).toContain("environment.json");
    expect(entryNames).toContain("connectors.json");
    expect(entryNames).toContain("agent-config.json");
    expect(entryNames).toContain("activity-log.json");
  });

  it("should include system-log.txt when Axiom returns system log data", async () => {
    const { runId } = await setupFailedRun(userId);

    context.mocks.axiom.queryAxiom
      .mockResolvedValueOnce([]) // agentEvents
      .mockResolvedValueOnce([{ log: "booting sandbox\n" }, { log: "ready\n" }]) // systemLog
      .mockResolvedValueOnce([]); // networkLog

    await postReportError({ runId, title: "Bug" });

    const zipBuffer = context.mocks.s3.uploadS3Buffer.mock
      .calls[0]![2] as Buffer;
    const zip = new AdmZip(zipBuffer);
    const systemLog = zip
      .getEntry("system-log.txt")
      ?.getData()
      .toString("utf-8");

    expect(systemLog).toBe("booting sandbox\nready\n");
  });

  it("should include network-log.jsonl when Axiom returns network log data", async () => {
    const { runId } = await setupFailedRun(userId);

    const networkEntry = {
      _time: "2024-01-01T00:00:01Z",
      runId,
      method: "GET",
      url: "https://api.github.com/repos",
      status: 200,
      firewall_action: "allow",
    };

    context.mocks.axiom.queryAxiom
      .mockResolvedValueOnce([]) // agentEvents
      .mockResolvedValueOnce([]) // systemLog
      .mockResolvedValueOnce([networkEntry]); // networkLog

    await postReportError({ runId, title: "Bug" });

    const zipBuffer = context.mocks.s3.uploadS3Buffer.mock
      .calls[0]![2] as Buffer;
    const zip = new AdmZip(zipBuffer);
    const networkLog = zip
      .getEntry("network-log.jsonl")
      ?.getData()
      .toString("utf-8");

    expect(networkLog).toBeDefined();
    const parsed = JSON.parse(networkLog!);
    expect(parsed.method).toBe("GET");
    expect(parsed.firewall_action).toBe("allow");
  });

  it("should exclude system-log.txt and network-log.jsonl when data is empty", async () => {
    const { runId } = await setupFailedRun(userId);

    await postReportError({ runId, title: "Bug" });

    const zipBuffer = context.mocks.s3.uploadS3Buffer.mock
      .calls[0]![2] as Buffer;
    const zip = new AdmZip(zipBuffer);
    const entryNames = zip.getEntries().map((e) => {
      return e.entryName;
    });

    expect(entryNames).not.toContain("system-log.txt");
    expect(entryNames).not.toContain("network-log.jsonl");
  });

  it("should succeed when system log or network log query fails", async () => {
    const { runId } = await setupFailedRun(userId);

    context.mocks.axiom.queryAxiom
      .mockResolvedValueOnce([]) // agentEvents succeeds
      .mockRejectedValueOnce(new Error("system log timeout")) // systemLog fails
      .mockRejectedValueOnce(new Error("network log timeout")); // networkLog fails

    const response = await postReportError({ runId, title: "Bug" });
    expect(response.status).toBe(200);

    const zipBuffer = context.mocks.s3.uploadS3Buffer.mock
      .calls[0]![2] as Buffer;
    const zip = new AdmZip(zipBuffer);
    const entryNames = zip.getEntries().map((e) => {
      return e.entryName;
    });

    // Core files still present
    expect(entryNames).toContain("manifest.json");
    expect(entryNames).toContain("chat-history.jsonl");
    // Failed logs excluded gracefully
    expect(entryNames).not.toContain("system-log.txt");
    expect(entryNames).not.toContain("network-log.jsonl");
  });

  it("should include run metadata in manifest.json", async () => {
    const { runId } = await setupFailedRun(userId);

    await postReportError({
      runId,
      title: "Bug",
      description: "Desc",
    });

    const zipBuffer = context.mocks.s3.uploadS3Buffer.mock
      .calls[0]![2] as Buffer;
    const zip = new AdmZip(zipBuffer);
    const manifest = JSON.parse(
      zip.getEntry("manifest.json")!.getData().toString("utf-8"),
    );

    expect(manifest.runId).toBe(runId);
    expect(manifest.orgId).toBe(orgId);
    expect(manifest.userId).toBe(userId);
    expect(manifest.reference).toMatch(/^er-[a-f0-9]{8}$/);
    expect(manifest.createdAt).toBeDefined();
  });

  it("should include run environment in environment.json", async () => {
    const { runId } = await setupFailedRun(userId);

    await postReportError({
      runId,
      title: "Bug",
    });

    const zipBuffer = context.mocks.s3.uploadS3Buffer.mock
      .calls[0]![2] as Buffer;
    const zip = new AdmZip(zipBuffer);
    const env = JSON.parse(
      zip.getEntry("environment.json")!.getData().toString("utf-8"),
    );

    expect(env.runId).toBe(runId);
    expect(env.orgId).toBe(orgId);
    expect(env.status).toBe("failed");
  });

  // -------------------------------------------------------------------------
  // Chat history
  // -------------------------------------------------------------------------

  it("should include user prompt in chat-history.jsonl", async () => {
    const { runId } = await setupFailedRun(userId, {
      prompt: "Deploy the service",
    });

    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      {
        runId,
        eventType: "assistant",
        eventData: { message: "Starting deploy" },
        _time: "2024-01-01T00:01:00Z",
        sequenceNumber: 1,
      },
    ]);

    await postReportError({ runId, title: "Deploy failed" });

    const zipBuffer = context.mocks.s3.uploadS3Buffer.mock
      .calls[0]![2] as Buffer;
    const zip = new AdmZip(zipBuffer);
    const lines = zip
      .getEntry("chat-history.jsonl")!
      .getData()
      .toString("utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        return JSON.parse(line);
      });

    const promptEvent = lines.find((e: Record<string, unknown>) => {
      return e.eventType === "user_prompt";
    });
    expect(promptEvent).toBeDefined();
    expect(promptEvent.eventData.role).toBe("user");
    expect(promptEvent.eventData.content).toBe("Deploy the service");
    expect(promptEvent.sequenceNumber).toBe(-1);
  });

  it("should collect events from all runs in a multi-run session", async () => {
    const sessionId = randomUUID();

    // First run (completed)
    const compose1 = await createTestCompose(`agent-${uniqueId("rpt")}`);
    const { runId: firstRunId } = await createTestRunInDb(
      userId,
      compose1.composeId,
      {
        status: "completed",
        prompt: "First prompt",
        createdAt: new Date("2024-01-01T00:00:00Z"),
        result: {
          agentSessionId: sessionId,
          checkpointId: "cp-1",
          conversationId: "cv-1",
        },
      },
    );

    // Continuation run (failed)
    const compose2 = await createTestCompose(`agent-${uniqueId("rpt")}`);
    const { runId: failedRunId } = await createTestRunInDb(
      userId,
      compose2.composeId,
      {
        status: "failed",
        prompt: "Second prompt",
        createdAt: new Date("2024-01-01T01:00:00Z"),
        continuedFromSessionId: sessionId,
      },
    );

    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      {
        runId: firstRunId,
        eventType: "assistant",
        _time: "2024-01-01T00:00:30Z",
        sequenceNumber: 1,
        eventData: { message: "done" },
      },
      {
        runId: failedRunId,
        eventType: "assistant",
        _time: "2024-01-01T01:00:30Z",
        sequenceNumber: 1,
        eventData: { message: "error" },
      },
    ]);

    await postReportError({ runId: failedRunId, title: "Session failed" });

    const zipBuffer = context.mocks.s3.uploadS3Buffer.mock
      .calls[0]![2] as Buffer;
    const zip = new AdmZip(zipBuffer);
    const lines = zip
      .getEntry("chat-history.jsonl")!
      .getData()
      .toString("utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        return JSON.parse(line);
      });

    // Should have prompts from both runs
    const promptEvents = lines.filter((e: Record<string, unknown>) => {
      return e.eventType === "user_prompt";
    });
    expect(promptEvents).toHaveLength(2);
    expect(promptEvents[0].eventData.content).toBe("First prompt");
    expect(promptEvents[1].eventData.content).toBe("Second prompt");

    // Axiom query should include both run IDs
    const aplQuery = context.mocks.axiom.queryAxiom.mock.calls[0]![0] as string;
    expect(aplQuery).toContain(firstRunId);
    expect(aplQuery).toContain(failedRunId);
  });

  // -------------------------------------------------------------------------
  // S3 & email
  // -------------------------------------------------------------------------

  it("should upload ZIP to error-reports/ S3 path", async () => {
    const { runId } = await setupFailedRun(userId);

    await postReportError({ runId, title: "Bug" });

    expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("error-reports/"),
      expect.any(Buffer),
      "application/zip",
    );
  });

  it("should upload to S3 path containing orgId", async () => {
    const { runId } = await setupFailedRun(userId);

    await postReportError({ runId, title: "Connector broke" });

    const s3Key = context.mocks.s3.uploadS3Buffer.mock.calls[0]![1] as string;
    expect(s3Key).toContain(`error-reports/${orgId}/`);
    expect(s3Key).toMatch(/er-[a-f0-9]{8}\.zip$/);
  });

  // -------------------------------------------------------------------------
  // Resilience
  // -------------------------------------------------------------------------

  it("should succeed even when Axiom query fails", async () => {
    const { runId } = await setupFailedRun(userId);

    context.mocks.axiom.queryAxiom.mockRejectedValueOnce(
      new Error("Axiom down"),
    );

    const response = await postReportError({ runId, title: "Bug" });
    expect(response.status).toBe(200);
    expect((await response.json()).reference).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Plain.com integration
  // -------------------------------------------------------------------------

  it("should route to Plain and skip email when PLAIN_API_KEY is set and Plain succeeds", async () => {
    vi.stubEnv("PLAIN_API_KEY", "plainkey_test_abc");
    reloadEnv();

    let plainCallCount = 0;
    const handler = http.post(PLAIN_API_URL, () => {
      plainCallCount++;
      if (plainCallCount === 1)
        return HttpResponse.json({
          data: {
            upsertTenant: {
              tenant: { id: "t1", externalId: "o1", name: "Org" },
              error: null,
            },
          },
        });
      if (plainCallCount === 2)
        return HttpResponse.json({
          data: {
            upsertCustomer: {
              customer: { id: "c1", externalId: "u1" },
              result: "CREATED",
              error: null,
            },
          },
        });
      if (plainCallCount === 3)
        return HttpResponse.json({
          data: {
            createThread: {
              thread: { id: "th1", externalId: "er-ref1" },
              error: null,
            },
          },
        });
      return HttpResponse.json({
        data: {
          createThreadEvent: { threadEvent: { id: "ev1" }, error: null },
        },
      });
    });
    server.use(handler.handler);

    const { runId } = await setupFailedRun(userId);
    const title = `Plain route test ${uniqueId("er")}`;

    const response = await postReportError({ runId, title });
    expect(response.status).toBe(200);
    const { reference } = await response.json();
    expect(reference).toMatch(/^er-[a-f0-9]{8}$/);

    // Plain was called (4 steps)
    expect(plainCallCount).toBe(4);
  });
});
