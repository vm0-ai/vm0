import { randomUUID } from "node:crypto";

import type {
  TestWorkflowTriggerStateActionBody,
  TestWorkflowTriggerStateActionResponse,
} from "@vm0/api-contracts/contracts/test-workflow-trigger-state";
import { command } from "ccstate";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testWorkflowTriggerStateRoutes } from "../../test-workflow-trigger-state";

const WORKFLOW_TRIGGER_STATE_ROUTE = "/api/test/workflow-trigger-state/action";

export interface WorkflowsFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface WorkflowRunStateRow {
  readonly id: string;
  readonly triggerSource: string | null;
}

interface WorkflowTriggerState {
  readonly lastRunId: string | null;
  readonly lastRunAt: string | null;
}

interface GithubProcessedWorkflowEvent {
  readonly githubDeliveryId: string;
  readonly action: string;
  readonly labelNameNormalized: string;
}

export interface GoogleCalendarWatchState {
  readonly id: string;
  readonly channelId: string;
  readonly channelToken: string;
  readonly resourceId: string;
  readonly syncToken: string | null;
}

interface GoogleCalendarProcessedEvent {
  readonly calendarEventId: string;
}

interface GoogleCalendarEventSnapshot {
  readonly calendarEventId: string;
}

interface GoogleCalendarWatchStateResult {
  readonly watches: readonly GoogleCalendarWatchState[];
  readonly processed: readonly GoogleCalendarProcessedEvent[];
  readonly snapshots: readonly GoogleCalendarEventSnapshot[];
}

interface SeedAgentForInstructionsResult {
  readonly agentId: string;
  readonly name: string;
  readonly workflowIdsByName: Readonly<Record<string, string>>;
}

function requestWorkflowState(
  signal: AbortSignal,
  body: TestWorkflowTriggerStateActionBody,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testWorkflowTriggerStateRoutes,
  });
  return Promise.resolve(
    app.request(WORKFLOW_TRIGGER_STATE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  signal: AbortSignal,
  body: TestWorkflowTriggerStateActionBody,
): Promise<TestWorkflowTriggerStateActionResponse> {
  const response = await requestWorkflowState(signal, body);
  expectOk(response, `workflow state ${String(body.action)}`);
  return await readJson<TestWorkflowTriggerStateActionResponse>(response);
}

function stringField(
  body: TestWorkflowTriggerStateActionResponse,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new Error(`workflow state response missing ${key}`);
  }
  return value;
}

function recordField(
  body: TestWorkflowTriggerStateActionResponse,
  key: string,
): Readonly<Record<string, string>> {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([entryKey, entryValue]) => {
      return typeof entryValue === "string" ? [[entryKey, entryValue]] : [];
    }),
  );
}

function recordsField<T>(
  body: TestWorkflowTriggerStateActionResponse,
  key: string,
  parse: (value: Record<string, unknown>) => T | null,
): readonly T[] {
  const value = body[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const parsed = parse(item as Record<string, unknown>);
    return parsed ? [parsed] : [];
  });
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export const seedWorkflowsFixture$ = command(
  async (_, _input: void, signal: AbortSignal): Promise<WorkflowsFixture> => {
    const response = await postAction(signal, {
      action: "seed-workflows-fixture",
    });
    const fixture = response.fixture;
    if (!fixture || typeof fixture !== "object") {
      throw new Error("seedWorkflowsFixture$: response missing fixture");
    }
    const orgId = (fixture as Record<string, unknown>).org_id;
    const userId = (fixture as Record<string, unknown>).user_id;
    if (typeof orgId !== "string" || typeof userId !== "string") {
      throw new Error("seedWorkflowsFixture$: invalid fixture response");
    }
    return { orgId, userId };
  },
);

export const deleteWorkflowsForFixture$ = command(
  async (_, fixture: WorkflowsFixture, signal: AbortSignal): Promise<void> => {
    await postAction(signal, {
      action: "delete-scenario",
      org_id: fixture.orgId,
    });
  },
);

export const seedWorkflowActiveRun$ = command(
  async (
    _,
    args: {
      readonly fixture: WorkflowsFixture;
      readonly agentId: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const response = await postAction(signal, {
      action: "seed-active-run",
      org_id: args.fixture.orgId,
      user_id: args.fixture.userId,
      agent_id: args.agentId,
    });
    return stringField(response, "run_id");
  },
);

export const setWorkflowTriggerRunState$ = command(
  async (
    _,
    args: {
      readonly triggerId: string;
      readonly lastRunId?: string | null;
      readonly lastRunAt?: Date | null;
      readonly nextRunAt?: Date | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "set-trigger-run-state",
      trigger_id: args.triggerId,
      last_run_id: args.lastRunId,
      last_run_at:
        args.lastRunAt === undefined
          ? undefined
          : (args.lastRunAt?.toISOString() ?? null),
      next_run_at:
        args.nextRunAt === undefined
          ? undefined
          : (args.nextRunAt?.toISOString() ?? null),
    });
  },
);

export const getWorkflowTriggerRunState$ = command(
  async (
    _,
    args: { readonly triggerId: string },
    signal: AbortSignal,
  ): Promise<readonly WorkflowRunStateRow[]> => {
    const response = await postAction(signal, {
      action: "get-run-state",
      trigger_id: args.triggerId,
    });
    return recordsField(response, "runs", (row) => {
      const id = row.id;
      return typeof id === "string"
        ? { id, triggerSource: nullableString(row.triggerSource) }
        : null;
    });
  },
);

export const getWorkflowTriggerState$ = command(
  async (
    _,
    args: { readonly triggerId: string },
    signal: AbortSignal,
  ): Promise<WorkflowTriggerState | null> => {
    const response = await postAction(signal, {
      action: "get-trigger",
      trigger_id: args.triggerId,
    });
    const trigger = response.trigger;
    if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
      return null;
    }
    const row = trigger as Record<string, unknown>;
    return {
      lastRunId: nullableString(row.lastRunId),
      lastRunAt: nullableString(row.lastRunAt),
    };
  },
);

export const seedWorkflowGithubInstallation$ = command(
  async (
    _,
    args: {
      readonly fixture: WorkflowsFixture;
      readonly composeId: string;
      readonly installationId?: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const response = await postAction(signal, {
      action: "seed-github-installation",
      org_id: args.fixture.orgId,
      compose_id: args.composeId,
      installation_id: args.installationId,
    });
    return stringField(response, "installation_id");
  },
);

export const seedWorkflowGithubUserLink$ = command(
  async (
    _,
    args: {
      readonly installationId: string;
      readonly userId: string;
      readonly githubUserId?: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "seed-github-user-link",
      installation_id: args.installationId,
      user_id: args.userId,
      github_user_id: args.githubUserId,
    });
  },
);

export const getWorkflowGithubProcessedEvents$ = command(
  async (
    _,
    args: { readonly triggerId: string },
    signal: AbortSignal,
  ): Promise<readonly GithubProcessedWorkflowEvent[]> => {
    const response = await postAction(signal, {
      action: "get-github-processed-events",
      trigger_id: args.triggerId,
    });
    return recordsField(response, "processed", (row) => {
      const githubDeliveryId = row.githubDeliveryId;
      const action = row.action;
      const labelNameNormalized = row.labelNameNormalized;
      return typeof githubDeliveryId === "string" &&
        typeof action === "string" &&
        typeof labelNameNormalized === "string"
        ? { githubDeliveryId, action, labelNameNormalized }
        : null;
    });
  },
);

export const seedWorkflowConnector$ = command(
  async (
    _,
    args: {
      readonly fixture: WorkflowsFixture;
      readonly connectorType: "gmail" | "google-calendar";
      readonly externalEmail?: string;
      readonly accessToken?: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const response = await postAction(signal, {
      action: "seed-connector",
      org_id: args.fixture.orgId,
      user_id: args.fixture.userId,
      connector_type: args.connectorType,
      external_email: args.externalEmail,
      access_token: args.accessToken,
    });
    return stringField(response, "connector_id");
  },
);

export const getWorkflowGoogleCalendarWatchState$ = command(
  async (
    _,
    args: { readonly connectorId: string; readonly triggerId?: string },
    signal: AbortSignal,
  ): Promise<GoogleCalendarWatchStateResult> => {
    const response = await postAction(signal, {
      action: "get-google-calendar-watch",
      connector_id: args.connectorId,
      trigger_id: args.triggerId,
    });
    return {
      watches: recordsField(response, "watches", (row) => {
        const id = row.id;
        const channelId = row.channelId;
        const channelToken = row.channelToken;
        const resourceId = row.resourceId;
        return typeof id === "string" &&
          typeof channelId === "string" &&
          typeof channelToken === "string" &&
          typeof resourceId === "string"
          ? {
              id,
              channelId,
              channelToken,
              resourceId,
              syncToken: nullableString(row.syncToken),
            }
          : null;
      }),
      processed: recordsField(response, "processed", (row) => {
        const calendarEventId = row.calendarEventId;
        return typeof calendarEventId === "string" ? { calendarEventId } : null;
      }),
      snapshots: recordsField(response, "snapshots", (row) => {
        const calendarEventId = row.calendarEventId;
        return typeof calendarEventId === "string" ? { calendarEventId } : null;
      }),
    };
  },
);

type AgentFramework = "claude-code" | "codex";

interface AgentComposeContent {
  readonly version: string;
  readonly agents: Readonly<
    Record<
      string,
      {
        readonly framework: AgentFramework;
        readonly instructions?: string;
      }
    >
  >;
}

function createAgentComposeContent(
  name: string,
  framework: AgentFramework,
  instructions: string | undefined,
): AgentComposeContent {
  return {
    version: "1",
    agents: {
      [name]: instructions ? { framework, instructions } : { framework },
    },
  };
}

export const seedAgentForInstructions$ = command(
  async (
    _,
    args: {
      orgId: string;
      userId: string;
      name?: string;
      displayName?: string | null;
      description?: string | null;
      sound?: string | null;
      avatarUrl?: string | null;
      workflowNames?: readonly string[];
      modelProviderId?: string | null;
      selectedModel?: string | null;
      preferPersonalProvider?: boolean;
      visibility?: "public" | "private";
      framework?: AgentFramework;
      instructions?: string;
      composeContent?: unknown;
      withComposeVersion?: boolean;
      withZeroAgent?: boolean;
    },
    signal: AbortSignal,
  ): Promise<SeedAgentForInstructionsResult> => {
    const agentName = args.name ?? `agent-${randomUUID().slice(0, 8)}`;
    const response = await postAction(signal, {
      action: "seed-agent-workflow",
      org_id: args.orgId,
      user_id: args.userId,
      agent_name: agentName,
      display_name: args.displayName,
      description: args.description,
      sound: args.sound,
      avatar_url: args.avatarUrl,
      workflow_names: args.workflowNames ? [...args.workflowNames] : undefined,
      model_provider_id: args.modelProviderId,
      selected_model: args.selectedModel,
      prefer_personal_provider: args.preferPersonalProvider,
      visibility: args.visibility,
      framework: args.framework,
      instructions: args.instructions,
      compose_content:
        args.composeContent ??
        (args.withComposeVersion === true
          ? createAgentComposeContent(
              agentName,
              args.framework ?? "claude-code",
              args.instructions,
            )
          : undefined),
      with_compose_version: args.withComposeVersion,
      with_zero_agent: args.withZeroAgent,
    });
    return {
      agentId: stringField(response, "agent_id"),
      name: stringField(response, "name"),
      workflowIdsByName: recordField(response, "workflow_ids_by_name"),
    };
  },
);
