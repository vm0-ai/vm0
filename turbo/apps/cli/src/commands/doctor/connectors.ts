import type {
  WorkflowConnectorReadinessEntry,
  WorkflowConnectorReadinessStatus,
  WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import chalk from "chalk";
import { Command } from "commander";

import {
  getWorkflow,
  getWorkflowConnectorReadiness,
  listWorkflows,
} from "../../lib/api/domains/workflows";
import { ApiRequestError } from "../../lib/api/core/client-factory";
import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { connectorActionUrl } from "../connector/action-url";
import { resolveWorkflowRef } from "../workflow/resolve-workflow-ref";
import { getPlatformOrigin } from "./platform-url";

const MAX_CONNECTOR_READINESS_CONCURRENCY = 4;

type ConnectorDoctorOutcome =
  | "attention"
  | "unknown"
  | "ready"
  | "no-connectors";

type ConnectorDoctorActionKind =
  | "connect"
  | "reconnect"
  | "review-permissions"
  | "enable-for-agent";

interface ConnectorDoctorAction {
  readonly kind: ConnectorDoctorActionKind;
  readonly label: string;
  readonly url: string;
}

interface ConnectorDoctorError {
  readonly code: string;
  readonly message: string;
  readonly status: number | null;
}

interface ConnectorDoctorEntry {
  readonly slug: string;
  readonly label: string;
  readonly reason: string;
  readonly status: WorkflowConnectorReadinessStatus;
  readonly action: ConnectorDoctorAction | null;
}

interface ConnectorDoctorWorkflow {
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
    readonly installationState: "installing" | "installed";
    readonly definitionLifecycle: "active" | "retired" | "unavailable";
    readonly readOnly: true;
  } | null;
  readonly outcome: ConnectorDoctorOutcome;
  readonly connectors: readonly ConnectorDoctorEntry[];
  readonly error: ConnectorDoctorError | null;
}

interface ConnectorDoctorReport {
  readonly schemaVersion: 1;
  readonly summary: {
    readonly checked: number;
    readonly attention: number;
    readonly unknown: number;
    readonly ready: number;
    readonly noConnectors: number;
  };
  readonly workflows: readonly ConnectorDoctorWorkflow[];
}

interface ConnectorsOptions {
  readonly agent?: string;
  readonly json?: boolean;
}

function currentRunUserId(): string {
  const payload = decodeSandboxTokenPayload();
  if (
    !payload ||
    typeof payload.userId !== "string" ||
    payload.userId.length === 0
  ) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  return payload.userId;
}

function connectorAction(
  entry: WorkflowConnectorReadinessEntry,
  agentId: string,
  platformOrigin: string,
): ConnectorDoctorAction | null {
  let kind: ConnectorDoctorActionKind;
  let label: string;
  let route: "connect" | "authorize";
  switch (entry.status) {
    case "reconnect-required": {
      kind = "reconnect";
      label = "Reconnect";
      route = "connect";
      break;
    }
    case "scope-mismatch": {
      kind = "review-permissions";
      label = "Review permissions";
      route = "connect";
      break;
    }
    case "not-connected": {
      kind = "connect";
      label = "Connect";
      route = "connect";
      break;
    }
    case "not-enabled-for-agent": {
      kind = "enable-for-agent";
      label = "Enable for agent";
      route = "authorize";
      break;
    }
    case "connected":
    case "unavailable": {
      return null;
    }
  }

  return {
    kind,
    label,
    url: connectorActionUrl({
      origin: platformOrigin,
      path: `/connectors/${encodeURIComponent(entry.connectorSlug)}/${route}`,
      agentId,
    }),
  };
}

function workflowIdentity(
  workflow: WorkflowSummary,
): Omit<ConnectorDoctorWorkflow, "outcome" | "connectors" | "error"> {
  return {
    id: workflow.id,
    name: workflow.name,
    displayName: workflow.displayName,
    agent: {
      id: workflow.agentId,
      name: workflow.agentName,
      displayName: workflow.agentDisplayName,
    },
    official: workflow.official
      ? {
          definitionName: workflow.official.definitionName,
          installationState: workflow.official.installationState,
          definitionLifecycle: workflow.official.definitionLifecycle,
          readOnly: workflow.official.readOnly,
        }
      : null,
  };
}

function apiRequestError(
  error: ApiRequestError,
  workflow: WorkflowSummary,
): ConnectorDoctorError {
  if (workflow.official && error.status === 409) {
    return {
      code: "OFFICIAL_WORKFLOW_UNSUPPORTED",
      message:
        "Connector readiness is unavailable for this Official Workflow during rollout.",
      status: 409,
    };
  }
  switch (error.status) {
    case 400: {
      return {
        code: "BAD_REQUEST",
        message: "The connector readiness request was rejected.",
        status: error.status,
      };
    }
    case 403: {
      return {
        code: "FORBIDDEN",
        message: "Connector readiness is not available for this workflow.",
        status: error.status,
      };
    }
    case 404: {
      return {
        code: "NOT_FOUND",
        message: "The workflow was not found during the readiness check.",
        status: error.status,
      };
    }
    case 409: {
      return {
        code: "CONFLICT",
        message: "The workflow could not be checked in its current state.",
        status: error.status,
      };
    }
    case 413: {
      return {
        code: "PAYLOAD_TOO_LARGE",
        message: "The workflow exceeds the connector readiness input limit.",
        status: error.status,
      };
    }
    case 503: {
      const timedOut = error.code === "CONNECTOR_READINESS_TIMEOUT";
      return {
        code: timedOut ? "CONNECTOR_READINESS_TIMEOUT" : "PROVIDER_UNAVAILABLE",
        message: timedOut
          ? "The connector readiness check timed out."
          : "The connector readiness provider is unavailable.",
        status: error.status,
      };
    }
    default: {
      return {
        code: "REQUEST_FAILED",
        message: "The connector readiness request failed.",
        status: error.status,
      };
    }
  }
}

function sanitizedRequestError(
  error: unknown,
  workflow: WorkflowSummary,
): ConnectorDoctorError {
  if (error instanceof ApiRequestError) {
    if (error.status === 401 || error.code === "UNAUTHORIZED") {
      throw error;
    }
    return apiRequestError(error, workflow);
  }
  if (
    (error instanceof Error || error instanceof DOMException) &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return {
      code: "REQUEST_TIMEOUT",
      message: "The connector readiness request timed out.",
      status: null,
    };
  }
  return {
    code: "REQUEST_FAILED",
    message: "The connector readiness request failed.",
    status: null,
  };
}

function workflowOutcome(
  connectors: readonly ConnectorDoctorEntry[],
): ConnectorDoctorOutcome {
  if (connectors.length === 0) {
    return "no-connectors";
  }
  if (
    connectors.some((connector) => {
      return connector.status === "unavailable";
    })
  ) {
    return "unknown";
  }
  if (
    connectors.some((connector) => {
      return connector.status !== "connected";
    })
  ) {
    return "attention";
  }
  return "ready";
}

async function diagnoseWorkflow(
  workflow: WorkflowSummary,
  platformOrigin: string,
): Promise<ConnectorDoctorWorkflow> {
  let response;
  try {
    response = await getWorkflowConnectorReadiness(workflow.id);
  } catch (error) {
    return {
      ...workflowIdentity(workflow),
      outcome: "unknown",
      connectors: [],
      error: sanitizedRequestError(error, workflow),
    };
  }
  const connectors = response.connectors.map((entry) => {
    return {
      slug: entry.connectorSlug,
      label: entry.label,
      reason: entry.reason,
      status: entry.status,
      action: connectorAction(entry, workflow.agentId, platformOrigin),
    } satisfies ConnectorDoctorEntry;
  });
  return {
    ...workflowIdentity(workflow),
    outcome: workflowOutcome(connectors),
    connectors,
    error: null,
  };
}

async function diagnoseWorkflows(
  workflows: readonly WorkflowSummary[],
  platformOrigin: string,
): Promise<readonly ConnectorDoctorWorkflow[]> {
  const results: Array<ConnectorDoctorWorkflow | undefined> = Array.from({
    length: workflows.length,
  });
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < workflows.length) {
      const index = nextIndex;
      nextIndex += 1;
      const workflow = workflows[index];
      if (!workflow) {
        throw new Error(`Workflow ${index} is missing from the report input`);
      }
      results[index] = await diagnoseWorkflow(workflow, platformOrigin);
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(MAX_CONNECTOR_READINESS_CONCURRENCY, workflows.length),
      },
      async () => {
        await worker();
      },
    ),
  );
  return results.map((result, index) => {
    if (!result) {
      throw new Error(`Workflow ${index} is missing from the report output`);
    }
    return result;
  });
}

function buildReport(
  workflows: readonly ConnectorDoctorWorkflow[],
): ConnectorDoctorReport {
  let attention = 0;
  let unknown = 0;
  let ready = 0;
  let noConnectors = 0;
  for (const workflow of workflows) {
    switch (workflow.outcome) {
      case "attention": {
        attention += 1;
        break;
      }
      case "unknown": {
        unknown += 1;
        break;
      }
      case "ready": {
        ready += 1;
        break;
      }
      case "no-connectors": {
        noConnectors += 1;
        break;
      }
    }
  }
  return {
    schemaVersion: 1,
    summary: {
      checked: workflows.length,
      attention,
      unknown,
      ready,
      noConnectors,
    },
    workflows,
  };
}

function compactText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function workflowLabel(workflow: ConnectorDoctorWorkflow): string {
  if (!workflow.displayName || workflow.displayName === workflow.name) {
    return workflow.name;
  }
  return `${compactText(workflow.displayName)} (${workflow.name})`;
}

function agentLabel(workflow: ConnectorDoctorWorkflow): string {
  return workflow.agent.displayName ?? workflow.agent.name ?? workflow.agent.id;
}

function readinessStatusLabel(
  status: WorkflowConnectorReadinessStatus,
): string {
  switch (status) {
    case "connected": {
      return "connected";
    }
    case "not-connected": {
      return "not connected";
    }
    case "scope-mismatch": {
      return "permission scope mismatch";
    }
    case "reconnect-required": {
      return "reconnect required";
    }
    case "not-enabled-for-agent": {
      return "not enabled for agent";
    }
    case "unavailable": {
      return "unavailable";
    }
  }
}

function printProblemSection(
  title: string,
  workflows: readonly ConnectorDoctorWorkflow[],
): void {
  if (workflows.length === 0) {
    return;
  }
  console.log(chalk.bold(`${title} (${workflows.length})`));
  for (const workflow of workflows) {
    console.log(`  ${workflowLabel(workflow)}`);
    console.log(chalk.dim(`    Agent: ${compactText(agentLabel(workflow))}`));
    if (workflow.error) {
      console.log(
        `    ${chalk.yellow(workflow.error.code)}: ${workflow.error.message}`,
      );
      continue;
    }
    for (const connector of workflow.connectors) {
      if (connector.status === "connected") {
        continue;
      }
      console.log(
        `    ${compactText(connector.label)}: ${readinessStatusLabel(connector.status)}`,
      );
      console.log(chalk.dim(`      ${compactText(connector.reason)}`));
      if (connector.action) {
        console.log(
          chalk.dim(`      ${connector.action.label}: ${connector.action.url}`),
        );
      }
    }
  }
}

function printHumanReport(report: ConnectorDoctorReport): void {
  if (report.summary.checked === 0) {
    console.log(
      chalk.green("✓ No owned or installed workflows to check for connectors"),
    );
    return;
  }
  if (report.summary.attention === 0 && report.summary.unknown === 0) {
    console.log(
      chalk.green(
        `✓ All clear: ${report.summary.checked} workflow${report.summary.checked === 1 ? "" : "s"} checked`,
      ),
    );
    console.log(
      chalk.dim(
        `  ${report.summary.ready} ready · ${report.summary.noConnectors} no connectors required`,
      ),
    );
    return;
  }

  console.log(chalk.bold("Connector diagnostics"));
  printProblemSection(
    "Needs attention",
    report.workflows.filter((workflow) => {
      return workflow.outcome === "attention";
    }),
  );
  printProblemSection(
    "Unknown",
    report.workflows.filter((workflow) => {
      return workflow.outcome === "unknown";
    }),
  );
  console.log(
    chalk.dim(
      `Summary: ${report.summary.checked} checked · ${report.summary.attention} attention · ${report.summary.unknown} unknown · ${report.summary.ready} ready · ${report.summary.noConnectors} no connectors`,
    ),
  );
}

async function selectedWorkflows(
  workflowRef: string | undefined,
  options: ConnectorsOptions,
): Promise<readonly WorkflowSummary[]> {
  if (workflowRef) {
    const workflowId = await resolveWorkflowRef(workflowRef, options);
    return [await getWorkflow(workflowId)];
  }
  if (options.agent) {
    throw new Error("--agent requires a workflow argument");
  }
  const userId = currentRunUserId();
  const workflows = await listWorkflows({});
  return workflows.filter((workflow) => {
    return workflow.ownerUserId === userId;
  });
}

export const connectorsCommand = new Command()
  .name("connectors")
  .description("Diagnose stored connector readiness across workflows")
  .argument("[workflow]", "Workflow ID or slug name")
  .option(
    "--agent <id>",
    "Agent scope for a workflow slug (defaults to OKOU_AGENT_ID)",
  )
  .option("--json", "Print a versioned machine-readable report")
  .addHelpText(
    "after",
    `
Examples:
  Check owned workflows: okou doctor connectors
  Check one workflow ID: okou doctor connectors <workflow-id>
  Check one workflow name: okou doctor connectors <workflow-name> --agent <agent-id>
  Print JSON: okou doctor connectors --json

Notes:
  - Without a workflow argument, only workflows owned or installed by the OKOU_TOKEN user are checked
  - Each workflow is checked through its stored connector-readiness route
  - Findings and per-workflow unknowns are report data and do not fail the command
  - Use okou connector check for one current-run URL, firewall decision, or permission failure`,
  )
  .action(
    withErrorHandler(
      async (workflowRef: string | undefined, options: ConnectorsOptions) => {
        const workflows = await selectedWorkflows(workflowRef, options);
        const platformOrigin = await getPlatformOrigin();
        const report = buildReport(
          await diagnoseWorkflows(workflows, platformOrigin),
        );
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        printHumanReport(report);
      },
    ),
  );
