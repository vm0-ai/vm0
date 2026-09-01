import type {
  WorkflowConnectorReadinessEntry,
  WorkflowDetailResponse,
  WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { connectorsCommand } from "../connectors";

const API_ORIGIN = "http://localhost:3000";
const OWNER_USER_ID = "user-owner";
const OTHER_USER_ID = "user-other";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const SECOND_AGENT_ID = "11111111-1111-1111-1111-111111111112";
const ATTENTION_WORKFLOW_ID = "20000000-0000-4000-8000-000000000001";
const UNKNOWN_WORKFLOW_ID = "20000000-0000-4000-8000-000000000002";
const READY_WORKFLOW_ID = "20000000-0000-4000-8000-000000000003";
const EMPTY_WORKFLOW_ID = "20000000-0000-4000-8000-000000000004";
const OFFICIAL_WORKFLOW_ID = "20000000-0000-4000-8000-000000000005";
const FOREIGN_WORKFLOW_ID = "20000000-0000-4000-8000-000000000006";
const SHADOWED_WORKFLOW_ID = "20000000-0000-4000-8000-000000000007";
const PRIVATE_WINNER_WORKFLOW_ID = "20000000-0000-4000-8000-000000000008";
const RAW_SECRET = "raw-secret-must-not-appear";

interface JsonConnector {
  readonly slug: string;
  readonly label: string;
  readonly reason: string;
  readonly status: string;
  readonly action: {
    readonly kind: string;
    readonly label: string;
    readonly url: string;
  } | null;
}

interface JsonWorkflow {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
  readonly agent: {
    readonly id: string;
    readonly name: string | null;
    readonly displayName: string | null;
  };
  readonly official: {
    readonly definitionName: string;
    readonly installationState: string;
    readonly definitionLifecycle: string;
    readonly readOnly: boolean;
  } | null;
  readonly outcome: string;
  readonly connectors: readonly JsonConnector[];
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly status: number | null;
  } | null;
}

interface JsonReport {
  readonly schemaVersion: number;
  readonly summary: {
    readonly checked: number;
    readonly attention: number;
    readonly unknown: number;
    readonly ready: number;
    readonly noConnectors: number;
  };
  readonly workflows: readonly JsonWorkflow[];
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function okouToken(userId: string): string {
  return `vm0_sandbox_${encodeJson({ alg: "HS256", typ: "JWT" })}.${encodeJson({
    userId,
    runId: "run-doctor",
    orgId: "org-doctor",
    scope: "okou",
    capabilities: ["agent:read"],
    iat: 1,
    exp: 4_102_444_800,
  })}.test-signature`;
}

function workflow(
  id: string,
  name: string,
  overrides: Partial<WorkflowSummary> = {},
): WorkflowSummary {
  return {
    id,
    agentId: AGENT_ID,
    agentName: "doctor-agent",
    agentDisplayName: "Doctor Agent",
    name,
    displayName: null,
    description: null,
    visibility: "private",
    ownerUserId: OWNER_USER_ID,
    createdAt: "2026-08-31T00:00:00.000Z",
    canManage: true,
    canPublish: true,
    official: null,
    shadowedBy: null,
    ...overrides,
  };
}

function workflowDetail(summary: WorkflowSummary): WorkflowDetailResponse {
  return {
    ...summary,
    createdByUserId: summary.ownerUserId,
    updatedByUserId: summary.ownerUserId,
    updatedAt: "2026-08-31T00:00:00.000Z",
    instruction: "Run the workflow.",
    files: null,
    fileContents: null,
    automations: [],
  };
}

function mockWorkflowList(workflows: readonly WorkflowSummary[]): void {
  server.use(
    http.get(`${API_ORIGIN}/api/workflows`, () => {
      return HttpResponse.json(workflows);
    }),
  );
}

function mockWorkflowDetail(summary: WorkflowSummary): void {
  server.use(
    http.get(`${API_ORIGIN}/api/workflows/${summary.id}`, () => {
      return HttpResponse.json(workflowDetail(summary));
    }),
  );
}

function reportFromOutput(output: string): JsonReport {
  return JSON.parse(output) as JsonReport;
}

describe("okou doctor connectors command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", API_ORIGIN);
    vi.stubEnv("OKOU_APP_URL", API_ORIGIN);
    vi.stubEnv("OKOU_TOKEN", okouToken(OWNER_USER_ID));
    connectorsCommand.setOptionValue("agent", undefined);
    connectorsCommand.setOptionValue("json", undefined);
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  function output(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  async function run(args: readonly string[] = []): Promise<void> {
    await connectorsCommand.parseAsync(["node", "cli", ...args]);
  }

  it("reports effective visible workflows with stable outcomes and action links", async () => {
    const attention = workflow(ATTENTION_WORKFLOW_ID, "attention-workflow", {
      displayName: "Attention Workflow",
      description: `Connector configuration ${RAW_SECRET}`,
    });
    const unknown = workflow(UNKNOWN_WORKFLOW_ID, "unknown-workflow");
    const ready = workflow(READY_WORKFLOW_ID, "ready-workflow");
    const empty = workflow(EMPTY_WORKFLOW_ID, "empty-workflow");
    const official = workflow(OFFICIAL_WORKFLOW_ID, "official-workflow", {
      official: {
        definitionName: "official-workflow",
        installationState: "installed",
        definitionLifecycle: "active",
        readOnly: true,
      },
    });
    const foreign = workflow(FOREIGN_WORKFLOW_ID, "foreign-workflow", {
      agentId: SECOND_AGENT_ID,
      agentName: "public-agent",
      agentDisplayName: "Public Agent",
      visibility: "public",
      ownerUserId: OTHER_USER_ID,
    });
    mockWorkflowList([attention, unknown, ready, empty, official, foreign]);

    const checkedWorkflowIds = new Set<string>();
    server.use(
      http.post(
        `${API_ORIGIN}/api/workflows/:workflowId/connector-readiness`,
        ({ params }) => {
          const workflowId = String(params.workflowId);
          checkedWorkflowIds.add(workflowId);
          if (workflowId === ATTENTION_WORKFLOW_ID) {
            return HttpResponse.json({
              connectors: [
                {
                  connectorSlug: "gmail",
                  label: "Gmail",
                  reason: "The workflow reads Gmail messages.",
                  status: "reconnect-required",
                },
                {
                  connectorSlug: "notion",
                  label: "Notion",
                  reason: "The workflow updates Notion pages.",
                  status: "scope-mismatch",
                },
                {
                  connectorSlug: "slack",
                  label: "Slack",
                  reason: "The workflow posts to Slack.",
                  status: "not-connected",
                },
                {
                  connectorSlug: "github",
                  label: "GitHub",
                  reason: "The workflow reads GitHub issues.",
                  status: "not-enabled-for-agent",
                },
                {
                  connectorSlug: "google-drive",
                  label: "Google Drive",
                  reason: "The workflow reads Drive files.",
                  status: "connected",
                },
              ] satisfies WorkflowConnectorReadinessEntry[],
            });
          }
          if (workflowId === UNKNOWN_WORKFLOW_ID) {
            return HttpResponse.json({
              connectors: [
                {
                  connectorSlug: "linear",
                  label: "Linear",
                  reason: "The connector is referenced by an automation.",
                  status: "unavailable",
                },
                {
                  connectorSlug: "github",
                  label: "GitHub",
                  reason: "The workflow reads GitHub issues.",
                  status: "connected",
                },
              ] satisfies WorkflowConnectorReadinessEntry[],
            });
          }
          if (workflowId === READY_WORKFLOW_ID) {
            return HttpResponse.json({
              connectors: [
                {
                  connectorSlug: "github",
                  label: "GitHub",
                  reason: "The workflow reads GitHub issues.",
                  status: "connected",
                },
              ] satisfies WorkflowConnectorReadinessEntry[],
            });
          }
          if (workflowId === EMPTY_WORKFLOW_ID) {
            return HttpResponse.json({ connectors: [] });
          }
          if (workflowId === OFFICIAL_WORKFLOW_ID) {
            return HttpResponse.json(
              {
                error: {
                  code: "CONFLICT",
                  message: `Official workflow conflict ${RAW_SECRET}`,
                },
              },
              { status: 409 },
            );
          }
          if (workflowId === FOREIGN_WORKFLOW_ID) {
            return HttpResponse.json({
              connectors: [
                {
                  connectorSlug: "github",
                  label: "GitHub",
                  reason: "The public workflow reads GitHub issues.",
                  status: "connected",
                },
              ] satisfies WorkflowConnectorReadinessEntry[],
            });
          }
          throw new Error(`Unexpected readiness request for ${workflowId}`);
        },
      ),
    );

    await run(["--json"]);

    const printed = output();
    const report = reportFromOutput(printed);
    expect(Object.keys(report)).toStrictEqual([
      "schemaVersion",
      "summary",
      "workflows",
    ]);
    expect(report.schemaVersion).toBe(1);
    expect(report.summary).toStrictEqual({
      checked: 6,
      attention: 1,
      unknown: 2,
      ready: 2,
      noConnectors: 1,
    });
    expect(checkedWorkflowIds).toStrictEqual(
      new Set([
        ATTENTION_WORKFLOW_ID,
        UNKNOWN_WORKFLOW_ID,
        READY_WORKFLOW_ID,
        EMPTY_WORKFLOW_ID,
        OFFICIAL_WORKFLOW_ID,
        FOREIGN_WORKFLOW_ID,
      ]),
    );

    const attentionResult = report.workflows.find((item) => {
      return item.id === ATTENTION_WORKFLOW_ID;
    });
    expect(Object.keys(attentionResult ?? {})).toStrictEqual([
      "id",
      "name",
      "displayName",
      "agent",
      "official",
      "outcome",
      "connectors",
      "error",
    ]);
    expect(attentionResult?.outcome).toBe("attention");
    expect(attentionResult?.connectors).toStrictEqual([
      {
        slug: "gmail",
        label: "Gmail",
        reason: "The workflow reads Gmail messages.",
        status: "reconnect-required",
        action: {
          kind: "reconnect",
          label: "Reconnect",
          url: `${API_ORIGIN}/connectors/gmail/connect?agentId=${AGENT_ID}`,
        },
      },
      {
        slug: "notion",
        label: "Notion",
        reason: "The workflow updates Notion pages.",
        status: "scope-mismatch",
        action: {
          kind: "review-permissions",
          label: "Review permissions",
          url: `${API_ORIGIN}/connectors/notion/connect?agentId=${AGENT_ID}`,
        },
      },
      {
        slug: "slack",
        label: "Slack",
        reason: "The workflow posts to Slack.",
        status: "not-connected",
        action: {
          kind: "connect",
          label: "Connect",
          url: `${API_ORIGIN}/connectors/slack/connect?agentId=${AGENT_ID}`,
        },
      },
      {
        slug: "github",
        label: "GitHub",
        reason: "The workflow reads GitHub issues.",
        status: "not-enabled-for-agent",
        action: {
          kind: "enable-for-agent",
          label: "Enable for agent",
          url: `${API_ORIGIN}/connectors/github/authorize?agentId=${AGENT_ID}`,
        },
      },
      {
        slug: "google-drive",
        label: "Google Drive",
        reason: "The workflow reads Drive files.",
        status: "connected",
        action: null,
      },
    ]);

    const unknownResult = report.workflows.find((item) => {
      return item.id === UNKNOWN_WORKFLOW_ID;
    });
    expect(unknownResult?.outcome).toBe("unknown");
    expect(unknownResult?.connectors[0]).toMatchObject({
      slug: "linear",
      status: "unavailable",
      action: null,
    });
    expect(
      report.workflows.find((item) => {
        return item.id === READY_WORKFLOW_ID;
      })?.outcome,
    ).toBe("ready");
    expect(
      report.workflows.find((item) => {
        return item.id === EMPTY_WORKFLOW_ID;
      })?.outcome,
    ).toBe("no-connectors");

    const officialResult = report.workflows.find((item) => {
      return item.id === OFFICIAL_WORKFLOW_ID;
    });
    expect(officialResult).toMatchObject({
      outcome: "unknown",
      official: {
        definitionName: "official-workflow",
        installationState: "installed",
        definitionLifecycle: "active",
        readOnly: true,
      },
      connectors: [],
      error: {
        code: "CONFLICT",
        message: "The workflow could not be checked in its current state.",
        status: 409,
      },
    });
    expect(
      report.workflows.find((item) => {
        return item.id === FOREIGN_WORKFLOW_ID;
      }),
    ).toMatchObject({
      agent: { id: SECOND_AGENT_ID },
      outcome: "ready",
    });
    expect(printed).not.toContain(RAW_SECRET);
    expect(printed).not.toContain(OWNER_USER_ID);
    expect(printed).not.toContain(process.env.OKOU_TOKEN);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("checks only the private runtime winner when it shadows a public workflow", async () => {
    const privateWinner = workflow(
      PRIVATE_WINNER_WORKFLOW_ID,
      "shared-workflow",
      { displayName: "Private Winner" },
    );
    const shadowedPublic = workflow(SHADOWED_WORKFLOW_ID, "shared-workflow", {
      displayName: "Public Workflow",
      visibility: "public",
      ownerUserId: OTHER_USER_ID,
      shadowedBy: {
        id: privateWinner.id,
        name: privateWinner.name,
        displayName: privateWinner.displayName,
      },
    });
    const publicWinner = workflow(FOREIGN_WORKFLOW_ID, "public-winner", {
      visibility: "public",
      ownerUserId: OTHER_USER_ID,
    });
    mockWorkflowList([shadowedPublic, privateWinner, publicWinner]);

    const checkedWorkflowIds = new Set<string>();
    server.use(
      http.post(
        `${API_ORIGIN}/api/workflows/:workflowId/connector-readiness`,
        ({ params }) => {
          checkedWorkflowIds.add(String(params.workflowId));
          return HttpResponse.json({ connectors: [] });
        },
      ),
    );

    await run(["--json"]);

    const report = reportFromOutput(output());
    expect(report.summary.checked).toBe(2);
    expect(checkedWorkflowIds).toStrictEqual(
      new Set([PRIVATE_WINNER_WORKFLOW_ID, FOREIGN_WORKFLOW_ID]),
    );
    expect(
      report.workflows.map((item) => {
        return item.id;
      }),
    ).toStrictEqual([PRIVATE_WINNER_WORKFLOW_ID, FOREIGN_WORKFLOW_ID]);
  });

  it("resolves a workflow name through the normal agent-scoped list", async () => {
    const selected = workflow(READY_WORKFLOW_ID, "sales-digest", {
      displayName: "Sales Digest",
    });
    let requestedAgentId: string | null = null;
    server.use(
      http.get(`${API_ORIGIN}/api/workflows`, ({ request }) => {
        requestedAgentId = new URL(request.url).searchParams.get("agentId");
        return HttpResponse.json([selected]);
      }),
    );
    mockWorkflowDetail(selected);
    server.use(
      http.post(
        `${API_ORIGIN}/api/workflows/${selected.id}/connector-readiness`,
        () => {
          return HttpResponse.json({ connectors: [] });
        },
      ),
    );

    await run([selected.name, "--agent", AGENT_ID, "--json"]);

    const report = reportFromOutput(output());
    expect(requestedAgentId).toBe(AGENT_ID);
    expect(report.summary.checked).toBe(1);
    expect(report.workflows[0]).toMatchObject({
      id: selected.id,
      name: selected.name,
      displayName: selected.displayName,
      outcome: "no-connectors",
    });
  });

  it("checks a workflow ID without listing other workflows", async () => {
    const selected = workflow(READY_WORKFLOW_ID, "direct-id", {
      visibility: "public",
      ownerUserId: OTHER_USER_ID,
      shadowedBy: {
        id: PRIVATE_WINNER_WORKFLOW_ID,
        name: "direct-id",
        displayName: "Private Direct ID",
      },
    });
    mockWorkflowDetail(selected);
    server.use(
      http.post(
        `${API_ORIGIN}/api/workflows/${selected.id}/connector-readiness`,
        () => {
          return HttpResponse.json({ connectors: [] });
        },
      ),
    );

    await run([selected.id, "--json"]);

    expect(reportFromOutput(output()).workflows[0]?.id).toBe(selected.id);
  });

  it("preserves the single-workflow all-clear copy", async () => {
    const selected = workflow(READY_WORKFLOW_ID, "direct-id");
    mockWorkflowDetail(selected);
    server.use(
      http.post(
        `${API_ORIGIN}/api/workflows/${selected.id}/connector-readiness`,
        () => {
          return HttpResponse.json({ connectors: [] });
        },
      ),
    );

    await run([selected.id]);

    expect(output()).toContain("✓ All clear: 1 workflow checked");
    expect(output()).toContain("0 ready · 1 no connectors required");
    expect(output()).not.toContain("Checked workflows by Agent:");
  });

  it("bounds readiness requests and keeps a partial failure in the report", async () => {
    const workflows = Array.from({ length: 6 }, (_, index) => {
      return workflow(
        `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        `workflow-${index + 1}`,
      );
    });
    mockWorkflowList(workflows);
    const requestedWorkflowIds = new Set<string>();
    let requestCount = 0;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    let releaseRequests: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    server.use(
      http.post(
        `${API_ORIGIN}/api/workflows/:workflowId/connector-readiness`,
        async ({ params }) => {
          const workflowId = String(params.workflowId);
          requestedWorkflowIds.add(workflowId);
          requestCount += 1;
          activeRequests += 1;
          maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
          if (requestCount <= 4) {
            await requestGate;
          }
          activeRequests -= 1;
          if (workflowId === workflows[4]?.id) {
            return HttpResponse.json(
              {
                error: {
                  code: "PROVIDER_UNAVAILABLE",
                  message: `Provider failed with ${RAW_SECRET}`,
                },
              },
              { status: 503 },
            );
          }
          return HttpResponse.json({ connectors: [] });
        },
      ),
    );

    const parsing = run(["--json"]);
    await expect
      .poll(() => {
        return requestCount;
      })
      .toBe(4);
    const firstWaveRequests = requestCount;
    if (!releaseRequests) {
      throw new Error(
        "Expected the connector readiness gate to be initialized",
      );
    }
    releaseRequests();
    await parsing;

    const printed = output();
    const report = reportFromOutput(printed);
    expect(firstWaveRequests).toBe(4);
    expect(maxActiveRequests).toBe(4);
    expect(requestedWorkflowIds).toStrictEqual(
      new Set(
        workflows.map((item) => {
          return item.id;
        }),
      ),
    );
    expect(report.summary).toStrictEqual({
      checked: 6,
      attention: 0,
      unknown: 1,
      ready: 0,
      noConnectors: 5,
    });
    expect(report.workflows[4]?.error).toStrictEqual({
      code: "PROVIDER_UNAVAILABLE",
      message: "The connector readiness provider is unavailable.",
      status: 503,
    });
    expect(printed).not.toContain(RAW_SECRET);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("prints actionable and unknown workflows before the compact summary", async () => {
    const attention = workflow(ATTENTION_WORKFLOW_ID, "needs-connector");
    const unknown = workflow(UNKNOWN_WORKFLOW_ID, "cannot-check");
    mockWorkflowList([attention, unknown]);
    server.use(
      http.post(
        `${API_ORIGIN}/api/workflows/:workflowId/connector-readiness`,
        ({ params }) => {
          if (String(params.workflowId) === attention.id) {
            return HttpResponse.json({
              connectors: [
                {
                  connectorSlug: "gmail",
                  label: "Gmail",
                  reason: "The workflow reads Gmail messages.",
                  status: "not-connected",
                },
              ] satisfies WorkflowConnectorReadinessEntry[],
            });
          }
          return HttpResponse.json(
            {
              error: {
                code: "PAYLOAD_TOO_LARGE",
                message: `Workflow input contains ${RAW_SECRET}`,
              },
            },
            { status: 413 },
          );
        },
      ),
    );

    await run();

    const printed = output();
    expect(printed).toContain("Needs attention (1)");
    expect(printed).toContain("Unknown (1)");
    expect(printed).toContain(
      `Connect: ${API_ORIGIN}/connectors/gmail/connect?agentId=${AGENT_ID}`,
    );
    expect(printed.indexOf("Needs attention")).toBeLessThan(
      printed.indexOf("Unknown"),
    );
    expect(printed.indexOf("Unknown")).toBeLessThan(
      printed.indexOf("Summary:"),
    );
    expect(printed).not.toContain(RAW_SECRET);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("prints effective visible all-clear coverage across every Agent", async () => {
    const ready = workflow(READY_WORKFLOW_ID, "ready-workflow");
    const empty = workflow(EMPTY_WORKFLOW_ID, "empty-workflow", {
      agentId: SECOND_AGENT_ID,
      agentName: "operations-agent",
      agentDisplayName: "Operations Agent",
      displayName: "Empty Workflow",
    });
    vi.stubEnv("OKOU_AGENT_ID", AGENT_ID);
    let requestedAgentId: string | null = AGENT_ID;
    server.use(
      http.get(`${API_ORIGIN}/api/workflows`, ({ request }) => {
        requestedAgentId = new URL(request.url).searchParams.get("agentId");
        return HttpResponse.json([ready, empty]);
      }),
    );
    server.use(
      http.post(
        `${API_ORIGIN}/api/workflows/:workflowId/connector-readiness`,
        ({ params }) => {
          if (String(params.workflowId) === ready.id) {
            return HttpResponse.json({
              connectors: [
                {
                  connectorSlug: "github",
                  label: "GitHub",
                  reason: "The workflow reads GitHub issues.",
                  status: "connected",
                },
              ] satisfies WorkflowConnectorReadinessEntry[],
            });
          }
          return HttpResponse.json({ connectors: [] });
        },
      ),
    );

    await run();

    const printed = output();
    expect(requestedAgentId).toBeNull();
    expect(printed).toContain("✓ All clear across effective visible workflows");
    expect(printed).toContain("2 checked · 1 ready · 1 no connectors required");
    expect(printed).toContain("Checked workflows by Agent:");
    expect(printed).toContain("Doctor Agent: ready-workflow");
    expect(printed).toContain(
      "Operations Agent: Empty Workflow (empty-workflow)",
    );
  });

  it("prints an empty effective-visible result without readiness requests", async () => {
    mockWorkflowList([]);
    let readinessRequests = 0;
    server.use(
      http.post(
        `${API_ORIGIN}/api/workflows/:workflowId/connector-readiness`,
        () => {
          readinessRequests += 1;
          return HttpResponse.json({ connectors: [] });
        },
      ),
    );

    await run();

    expect(output()).toContain(
      "No effective visible workflows to check for connectors",
    );
    expect(readinessRequests).toBe(0);
  });

  it("fails when the aggregate workflow list rejects authentication", async () => {
    vi.stubEnv("OKOU_TOKEN", "invalid-token");
    server.use(
      http.get(`${API_ORIGIN}/api/workflows`, () => {
        return HttpResponse.json(
          { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    await expect(run()).rejects.toThrow("process.exit called");

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Authentication failed",
    );
  });

  it("checks only effective public and private workflows on an aggregate Agent scope", async () => {
    const privateWinner = workflow(
      PRIVATE_WINNER_WORKFLOW_ID,
      "shared-workflow",
      { displayName: "Private Winner" },
    );
    const publicWorkflow = workflow(FOREIGN_WORKFLOW_ID, "public-workflow", {
      visibility: "public",
      ownerUserId: OTHER_USER_ID,
    });
    const shadowedPublic = workflow(SHADOWED_WORKFLOW_ID, "shared-workflow", {
      visibility: "public",
      ownerUserId: OTHER_USER_ID,
      shadowedBy: {
        id: privateWinner.id,
        name: privateWinner.name,
        displayName: privateWinner.displayName,
      },
    });
    const otherAgentWorkflow = workflow(
      UNKNOWN_WORKFLOW_ID,
      "other-agent-workflow",
      {
        agentId: SECOND_AGENT_ID,
        agentName: "other-agent",
        agentDisplayName: "Other Agent",
      },
    );
    let requestedAgentId: string | null = null;
    server.use(
      http.get(`${API_ORIGIN}/api/workflows`, ({ request }) => {
        requestedAgentId = new URL(request.url).searchParams.get("agentId");
        return HttpResponse.json([
          shadowedPublic,
          privateWinner,
          publicWorkflow,
          otherAgentWorkflow,
        ]);
      }),
    );
    const checkedWorkflowIds = new Set<string>();
    server.use(
      http.post(
        `${API_ORIGIN}/api/workflows/:workflowId/connector-readiness`,
        ({ params }) => {
          const workflowId = String(params.workflowId);
          checkedWorkflowIds.add(workflowId);
          return HttpResponse.json({
            connectors: [
              {
                connectorSlug:
                  workflowId === privateWinner.id ? "gmail" : "slack",
                label: workflowId === privateWinner.id ? "Gmail" : "Slack",
                reason: "The workflow uses an external connector.",
                status: "not-connected",
              },
            ] satisfies WorkflowConnectorReadinessEntry[],
          });
        },
      ),
    );

    await run(["--agent", AGENT_ID, "--json"]);

    const printed = output();
    const report = reportFromOutput(printed);
    expect(requestedAgentId).toBe(AGENT_ID);
    expect(checkedWorkflowIds).toStrictEqual(
      new Set([PRIVATE_WINNER_WORKFLOW_ID, FOREIGN_WORKFLOW_ID]),
    );
    expect(report.summary).toStrictEqual({
      checked: 2,
      attention: 2,
      unknown: 0,
      ready: 0,
      noConnectors: 0,
    });
    expect(
      report.workflows.map((item) => {
        return item.id;
      }),
    ).toStrictEqual([PRIVATE_WINNER_WORKFLOW_ID, FOREIGN_WORKFLOW_ID]);
    for (const item of report.workflows) {
      expect(item.agent.id).toBe(AGENT_ID);
      expect(item.connectors[0]?.action?.url).toMatch(
        new RegExp(`\\?agentId=${AGENT_ID}$`, "u"),
      );
    }
    expect(printed).not.toContain(SECOND_AGENT_ID);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("documents the effective visible aggregate scope", () => {
    let help = "";
    connectorsCommand.configureOutput({
      writeOut: (text: string) => {
        help += text;
      },
    });
    connectorsCommand.outputHelp();
    help = help.replace(/\s+/gu, " ");

    expect(help).toContain(
      "Without a workflow argument or --agent, every effective visible workflow across all visible Agents is checked; shadowed workflows are skipped",
    );
    expect(help).toContain(
      "With --agent and no workflow argument, every effective workflow hosted by that Agent is checked; public and private workflows are included; shadowed workflows are skipped",
    );
    expect(help).toContain(
      "With a workflow argument, --agent scopes workflow slug resolution; slugs otherwise use OKOU_AGENT_ID, while workflow IDs retain their existing direct lookup behavior",
    );
  });
});
