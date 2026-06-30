import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import type {
  TestWorkflowTriggerStateActionBody,
  TestWorkflowTriggerStateActionResponse,
} from "@vm0/api-contracts/contracts/test-workflow-trigger-state";
import { command } from "ccstate";

import type { TestContext } from "../../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../../app-factory-core";
import { testWorkflowTriggerStateRoutes } from "../../test-workflow-trigger-state";

const WORKFLOW_TRIGGER_STATE_ROUTE = "/api/test/workflow-trigger-state/action";

export interface WorkflowsFixture {
  readonly orgId: string;
  readonly userId: string;
}

export interface WorkflowRunStateRow {
  readonly id: string;
  readonly triggerSource: string | null;
}

export interface WorkflowTriggerState {
  readonly lastRunId: string | null;
  readonly lastRunAt: string | null;
}

export interface GithubProcessedWorkflowEvent {
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

export interface GoogleCalendarProcessedEvent {
  readonly calendarEventId: string;
}

export interface GoogleCalendarEventSnapshot {
  readonly calendarEventId: string;
}

export interface GoogleCalendarWatchStateResult {
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

export const seedWorkflow$ = command(
  async (
    _,
    args: {
      orgId: string;
      userId: string;
      agentId: string;
      name: string;
      visibility?: "public" | "private";
      instruction?: string | null;
      displayName?: string | null;
      description?: string | null;
      updatedByUserId?: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const response = await postAction(signal, {
      action: "seed-workflow",
      org_id: args.orgId,
      user_id: args.userId,
      agent_id: args.agentId,
      name: args.name,
      visibility: args.visibility,
      instruction: args.instruction,
      display_name: args.displayName,
      description: args.description,
      updated_by_user_id: args.updatedByUserId,
    });
    return stringField(response, "workflow_id");
  },
);

interface WorkflowStorageSeed {
  readonly orgId: string;
  readonly userId: string;
  // The workflow volume is keyed by the workflow id under the agent-scoped model.
  readonly workflowId: string;
  readonly s3Key: string;
  readonly headVersionId: string;
  readonly type?: string;
}

export const seedWorkflowStorage$ = command(
  async (_, args: WorkflowStorageSeed, signal: AbortSignal): Promise<void> => {
    await postAction(signal, {
      action: "seed-workflow-storage",
      org_id: args.orgId,
      user_id: args.userId,
      workflow_id: args.workflowId,
      s3_key: args.s3Key,
      head_version_id: args.headVersionId,
      type: args.type,
    });
  },
);

interface WorkflowContentMockExtra {
  readonly path: string;
  readonly content: string;
}

interface WorkflowContentMockArgs {
  readonly s3Key: string;
  readonly content: string;
  readonly extraFiles?: readonly WorkflowContentMockExtra[];
}

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

const TAR_BLOCK_SIZE = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function createTarEntry(filename: string, content: Buffer): Buffer {
  // POSIX tar header (USTAR-compatible) is sufficient for extractFileFromTarGz
  // to parse the filename, size, and payload.
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(filename, 0, 100, "utf8");
  header.write("0000644\0", 100); // mode
  header.write("0000000\0", 108); // uid
  header.write("0000000\0", 116); // gid
  header.write(octal(content.length, 12), 124); // size
  header.write(octal(0, 12), 136); // mtime
  // Checksum placeholder: 8 spaces required so the checksum sum is correct.
  header.write("        ", 148);
  header.write("0", 156); // type flag (regular file)

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  // Final checksum: 6 octal digits, NUL, space.
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);

  const padding = content.length % TAR_BLOCK_SIZE;
  const dataBlocks =
    padding === 0
      ? content
      : Buffer.concat([content, Buffer.alloc(TAR_BLOCK_SIZE - padding)]);

  return Buffer.concat([header, dataBlocks]);
}

function createTarGz(
  files: readonly { readonly filename: string; readonly content: Buffer }[],
): Buffer {
  const eofBlocks = Buffer.alloc(TAR_BLOCK_SIZE * 2);
  return gzipSync(
    Buffer.concat([
      ...files.map((file) => {
        return createTarEntry(file.filename, file.content);
      }),
      eofBlocks,
    ]),
  );
}

function asyncIterableOf(buffer: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
  };
}

function commandKey(command: unknown): string {
  if (
    typeof command !== "object" ||
    command === null ||
    !("input" in command)
  ) {
    return "";
  }
  const input = (command as { input: unknown }).input;
  if (
    typeof input !== "object" ||
    input === null ||
    !("Key" in input) ||
    typeof (input as { Key: unknown }).Key !== "string"
  ) {
    return "";
  }
  return (input as { Key: string }).Key;
}

export function mockWorkflowContent(
  context: TestContext,
  args: WorkflowContentMockArgs,
): void {
  const contentBuffer = Buffer.from(args.content, "utf8");
  const extraFiles = (args.extraFiles ?? []).map((file) => {
    return {
      path: file.path,
      content: Buffer.from(file.content, "utf8"),
    };
  });
  const archive = createTarGz([
    { filename: "SKILL.md", content: contentBuffer },
    ...extraFiles.map((file) => {
      return { filename: file.path, content: file.content };
    }),
  ]);

  const manifest = {
    version: "test-version",
    createdAt: new Date(0).toISOString(),
    files: [
      { path: "SKILL.md", hash: "test-hash-skill", size: contentBuffer.length },
      ...extraFiles.map((file) => {
        return {
          path: file.path,
          hash: "test-hash-extra",
          size: file.content.length,
        };
      }),
    ],
    totalSize:
      contentBuffer.length +
      extraFiles.reduce((sum, file) => {
        return sum + file.content.length;
      }, 0),
    fileCount: 1 + extraFiles.length,
  };
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8");

  context.mocks.s3.send.mockImplementation((cmd: unknown): Promise<unknown> => {
    const key = commandKey(cmd);
    if (key === `${args.s3Key}/manifest.json`) {
      return Promise.resolve({ Body: asyncIterableOf(manifestBuffer) });
    }
    if (key === `${args.s3Key}/archive.tar.gz`) {
      return Promise.resolve({ Body: asyncIterableOf(archive) });
    }
    return Promise.resolve({});
  });
}

export function mockMissingWorkflowContent(
  context: TestContext,
  args: { readonly s3Key: string },
): void {
  context.mocks.s3.send.mockImplementation((cmd: unknown): Promise<unknown> => {
    const key = commandKey(cmd);
    if (
      key === `${args.s3Key}/manifest.json` ||
      key === `${args.s3Key}/archive.tar.gz`
    ) {
      return Promise.reject(
        Object.assign(new Error(`No such key: ${key}`), {
          name: "NoSuchKey",
          Code: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        }),
      );
    }
    return Promise.resolve({});
  });
}

interface InstructionsStorageSeed {
  readonly orgId: string;
  readonly userId: string;
  readonly agentName: string;
  readonly s3Key: string;
  readonly headVersionId?: string;
}

export const seedInstructionsStorage$ = command(
  async (
    _,
    args: InstructionsStorageSeed,
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "seed-instructions-storage",
      org_id: args.orgId,
      user_id: args.userId,
      agent_name: args.agentName,
      s3_key: args.s3Key,
      head_version_id: args.headVersionId,
    });
  },
);

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
