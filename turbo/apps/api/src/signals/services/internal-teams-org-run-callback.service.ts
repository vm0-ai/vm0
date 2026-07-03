import { command } from "ccstate";
import { formatRunErrorForExternalSurface } from "@vm0/api-contracts/contracts/errors";
import {
  getFrameworkForType,
  modelProviderTypeSchema,
} from "@vm0/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { teamsOrgConnections } from "@vm0/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@vm0/db/schema/teams-org-installation";
import { teamsOrgThreadSessions } from "@vm0/db/schema/teams-org-thread-session";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import {
  sendTeamsMessageReply,
  sendTeamsTypingActivity,
} from "../external/teams-bot-client";
import { nowDate } from "../external/time";
import { settle } from "../utils";
import {
  loadUserFeatureSwitchContext,
  userFeatureSwitchOverrides,
} from "./feature-switches.service";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";
import { formatRunErrorForRunOwner$ } from "./run-error-format.service";
import { getRunOutputText } from "./run-output.service";
import {
  teamsOrgCallbackPayloadSchema,
  type TeamsOrgCallbackPayload,
} from "./teams-org-callback-payload";

const L = logger("InternalCallbacksTeamsOrg");
const ORG_SENTINEL_USER_ID = "__org__";

type TerminalStatus = "completed" | "failed";

interface RunContext {
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly sessionId: string | null;
  readonly lastEventSequence: number | null;
  readonly chatThreadId: string | null;
}

interface TeamsInstallation {
  readonly orgId: string | null;
  readonly serviceUrl: string | null;
}

type TeamsOrgCallbackResult =
  | { readonly status: 200; readonly body: { readonly success: true } }
  | {
      readonly status: 400 | 404 | 502;
      readonly body: { readonly error: string };
    };

type TeamsOrgInternalCallbackResult =
  | { readonly success: true; readonly skipped?: true }
  | {
      readonly success: false;
      readonly error: string;
      readonly status: 400 | 404 | 502;
    };

function successResponse(): {
  readonly status: 200;
  readonly body: { readonly success: true };
} {
  return { status: 200, body: { success: true } };
}

function errorResponse(
  status: 400 | 404 | 502,
  message: string,
): {
  readonly status: 400 | 404 | 502;
  readonly body: { readonly error: string };
} {
  return { status, body: { error: message } };
}

function parsePayload(payload: unknown): TeamsOrgCallbackPayload | null {
  const result = teamsOrgCallbackPayloadSchema.safeParse(payload);
  return result.success ? result.data : null;
}

function dispatchResultFromResponse(
  result: TeamsOrgCallbackResult,
): TeamsOrgInternalCallbackResult {
  if (result.status === 200) {
    return { success: true };
  }
  return {
    success: false,
    status: result.status,
    error: result.body.error,
  };
}

function buildLogsUrl(runId: string): string {
  return `${env("APP_URL")}/activities/${encodeURIComponent(runId)}`;
}

async function loadInstallation(args: {
  readonly db: Db;
  readonly tenantId: string;
  readonly signal: AbortSignal;
}): Promise<TeamsInstallation | undefined> {
  const [installation] = await args.db
    .select({
      orgId: teamsOrgInstallations.orgId,
      serviceUrl: teamsOrgInstallations.serviceUrl,
    })
    .from(teamsOrgInstallations)
    .where(eq(teamsOrgInstallations.teamsTenantId, args.tenantId))
    .limit(1);
  args.signal.throwIfAborted();
  return installation;
}

async function loadRunContext(args: {
  readonly db: Db;
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<RunContext | undefined> {
  const [run] = await args.db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      prompt: agentRuns.prompt,
      sessionId: agentRuns.sessionId,
      lastEventSequence: agentRuns.lastEventSequence,
      chatThreadId: zeroRuns.chatThreadId,
    })
    .from(agentRuns)
    .leftJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(agentRuns.id, args.runId))
    .limit(1);
  args.signal.throwIfAborted();
  return run;
}

async function resolveRunSelectedModel(
  db: Db,
  runId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ selectedModel: zeroRuns.selectedModel })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row?.selectedModel ?? undefined;
}

async function resolveOrgDefaultModelProviderSelectedModel(
  db: Db,
  orgId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({
      type: modelProviders.type,
      selectedModel: modelProviders.selectedModel,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.isDefault, true),
      ),
    );
  const row = rows.find((candidate) => {
    const parsed = modelProviderTypeSchema.safeParse(candidate.type);
    return parsed.success && getFrameworkForType(parsed.data) === "claude-code";
  });
  return row?.selectedModel ?? undefined;
}

async function resolveModelLabel(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly runId: string;
}): Promise<string | undefined> {
  const selectedModel = await resolveRunSelectedModel(args.db, args.runId);
  const model =
    selectedModel ??
    (await resolveOrgDefaultModelProviderSelectedModel(args.db, args.orgId));
  return model ? getModelDisplayName(model) : undefined;
}

async function resolveRespondedByLabel(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly composeId: string;
}): Promise<string | undefined> {
  const [orgRow] = await args.db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);

  if (args.composeId === orgRow?.defaultAgentId) {
    return undefined;
  }

  const [agent] = await args.db
    .select({ displayName: zeroAgents.displayName, name: zeroAgents.name })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, args.composeId))
    .limit(1);
  const label = agent?.displayName ?? agent?.name;
  return label ? `Responded by ${label}` : undefined;
}

async function resolveFooterText(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly runId: string;
  readonly payload: TeamsOrgCallbackPayload;
}): Promise<string | undefined> {
  const [respondedBy, modelLabel] = await Promise.all([
    resolveRespondedByLabel({
      db: args.db,
      orgId: args.orgId,
      composeId: args.payload.agentId,
    }),
    resolveModelLabel({
      db: args.db,
      orgId: args.orgId,
      runId: args.runId,
    }),
  ]);

  const parts: string[] = [];
  if (respondedBy) {
    parts.push(respondedBy);
  }
  if (modelLabel) {
    parts.push(modelLabel);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

async function resolveAuditLogsUrl(args: {
  readonly runId: string;
  readonly run: RunContext | undefined;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  if (!args.run) {
    return undefined;
  }

  const overrides = await args.getFeatureOverrides(
    args.run.orgId,
    args.run.userId,
  );
  args.signal.throwIfAborted();
  const typedOverrides =
    Object.keys(overrides).length > 0
      ? (overrides as Partial<Record<FeatureSwitchKey, boolean>>)
      : undefined;
  const enabled = isFeatureEnabled(FeatureSwitchKey.ZeroDebug, {
    userId: args.run.userId,
    orgId: args.run.orgId,
    overrides: typedOverrides,
  });
  return enabled ? buildLogsUrl(args.runId) : undefined;
}

function buildTeamsResponseText(args: {
  readonly mainText: string;
  readonly logsUrl: string | undefined;
  readonly footerText: string | undefined;
}): string {
  return [
    args.mainText,
    args.logsUrl ? `[View run details](${args.logsUrl})` : undefined,
    args.footerText ? `_${args.footerText}_` : undefined,
  ]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}

async function resolveCompletionText(args: {
  readonly runId: string;
  readonly status: TerminalStatus;
  readonly run: RunContext | undefined;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  if (args.status === "failed") {
    return undefined;
  }

  const output = await getRunOutputText(args.runId, {
    waitForOutput: false,
    knownLastEventSequence: args.run?.lastEventSequence,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  return output;
}

function teamsApiCallbackError(
  result: Extract<
    Awaited<ReturnType<typeof sendTeamsMessageReply>>,
    { readonly kind: "teams-error" }
  >,
): {
  readonly status: 400 | 502;
  readonly body: { readonly error: string };
} {
  return {
    status: result.status >= 500 ? 502 : 400,
    body: {
      error: `Microsoft Teams API error: ${result.error}`,
    },
  };
}

function resolveServiceUrl(args: {
  readonly payload: TeamsOrgCallbackPayload;
  readonly installation: TeamsInstallation;
}): string {
  return args.payload.serviceUrl.trim() || args.installation.serviceUrl || "";
}

async function connectionStillExists(args: {
  readonly db: Db;
  readonly payload: TeamsOrgCallbackPayload;
}): Promise<boolean> {
  const [connection] = await args.db
    .select({ id: teamsOrgConnections.id })
    .from(teamsOrgConnections)
    .where(
      and(
        eq(teamsOrgConnections.id, args.payload.connectionId),
        eq(teamsOrgConnections.teamsTenantId, args.payload.tenantId),
      ),
    )
    .limit(1);
  return Boolean(connection);
}

async function saveOrgThreadSession(args: {
  readonly db: Db;
  readonly payload: TeamsOrgCallbackPayload;
  readonly run: RunContext | undefined;
  readonly status: TerminalStatus;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.status === "failed" || !args.run) {
    return;
  }

  const agentSessionId = args.payload.existingSessionId ?? args.run.sessionId;
  if (args.payload.existingSessionId || !agentSessionId) {
    return;
  }

  if (
    !(await connectionStillExists({
      db: args.db,
      payload: args.payload,
    }))
  ) {
    return;
  }
  args.signal.throwIfAborted();

  await args.db
    .insert(teamsOrgThreadSessions)
    .values({
      connectionId: args.payload.connectionId,
      teamsConversationId: args.payload.conversationId,
      teamsChannelId: args.payload.channelId,
      teamsThreadId: args.payload.threadId,
      agentSessionId,
    })
    .onConflictDoUpdate({
      target: [
        teamsOrgThreadSessions.connectionId,
        teamsOrgThreadSessions.teamsConversationId,
        teamsOrgThreadSessions.teamsThreadId,
      ],
      set: {
        agentSessionId,
        teamsChannelId: args.payload.channelId,
        updatedAt: nowDate(),
      },
    });
  args.signal.throwIfAborted();
}

async function handleProgress(args: {
  readonly payload: TeamsOrgCallbackPayload;
  readonly signal: AbortSignal;
}): Promise<TeamsOrgCallbackResult> {
  const typingResult = await settle(
    sendTeamsTypingActivity({
      serviceUrl: args.payload.serviceUrl,
      conversationId: args.payload.conversationId,
      tenantId: args.payload.tenantId,
      signal: args.signal,
    }),
    args.signal,
  );
  const error = !typingResult.ok
    ? typingResult.error
    : typingResult.value.kind === "teams-error"
      ? typingResult.value.error
      : undefined;
  if (error !== undefined) {
    L.debug("Failed to refresh Teams typing indicator", {
      tenantId: args.payload.tenantId,
      conversationId: args.payload.conversationId,
      error,
    });
  }
  return successResponse();
}

async function handleCompletion(args: {
  readonly db: Db;
  readonly runId: string;
  readonly status: TerminalStatus;
  readonly error: string | undefined;
  readonly payload: TeamsOrgCallbackPayload;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly formatRunError: (params: {
    readonly runId: string;
    readonly chatThreadId: string | null | undefined;
    readonly errorMessage: string;
  }) => Promise<string>;
  readonly signal: AbortSignal;
}): Promise<TeamsOrgCallbackResult> {
  const installation = await loadInstallation({
    db: args.db,
    tenantId: args.payload.tenantId,
    signal: args.signal,
  });
  if (!installation) {
    L.error("Teams org installation not found", {
      tenantId: args.payload.tenantId,
    });
    return errorResponse(404, "Microsoft Teams installation not found");
  }

  const run = await loadRunContext({
    db: args.db,
    runId: args.runId,
    signal: args.signal,
  });
  if (run && installation.orgId !== run.orgId) {
    L.warn("Teams org installation no longer belongs to run org", {
      tenantId: args.payload.tenantId,
      runId: args.runId,
      installationOrgId: installation.orgId,
      runOrgId: run.orgId,
    });
    return errorResponse(404, "Microsoft Teams installation not found");
  }

  const serviceUrl = resolveServiceUrl({
    payload: args.payload,
    installation,
  });
  if (!serviceUrl) {
    return errorResponse(400, "Microsoft Teams serviceUrl is missing");
  }

  const output = await resolveCompletionText({
    runId: args.runId,
    status: args.status,
    run,
    signal: args.signal,
  });
  const logsUrl = await resolveAuditLogsUrl({
    runId: args.runId,
    run,
    getFeatureOverrides: args.getFeatureOverrides,
    signal: args.signal,
  });
  const footerText = run
    ? await resolveFooterText({
        db: args.db,
        orgId: run.orgId,
        runId: args.runId,
        payload: args.payload,
      })
    : undefined;
  args.signal.throwIfAborted();

  const errorText =
    args.status === "failed"
      ? await args.formatRunError({
          runId: args.runId,
          chatThreadId: run?.chatThreadId,
          errorMessage: args.error ?? "Agent execution failed.",
        })
      : undefined;
  args.signal.throwIfAborted();

  const responseText = buildTeamsResponseText({
    mainText:
      args.status === "failed"
        ? (errorText ?? "Agent execution failed.")
        : (output ?? "Task completed successfully."),
    logsUrl,
    footerText,
  });
  const sendResult = await sendTeamsMessageReply({
    serviceUrl,
    conversationId: args.payload.conversationId,
    activityId: args.payload.activityId ?? undefined,
    tenantId: args.payload.tenantId,
    text: responseText,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (sendResult.kind === "teams-error") {
    return teamsApiCallbackError(sendResult);
  }

  await saveOrgThreadSession({
    db: args.db,
    payload: args.payload,
    run,
    status: args.status,
    signal: args.signal,
  });

  L.debug("Teams org callback processed successfully", { runId: args.runId });
  return successResponse();
}

interface HandleTeamsOrgInternalCallbackInput {
  readonly db: Db;
  readonly callback: InternalRunCallbackEnvelope;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly formatRunError: (params: {
    readonly runId: string;
    readonly chatThreadId: string | null | undefined;
    readonly errorMessage: string;
  }) => Promise<string>;
  readonly signal?: AbortSignal;
}

async function handleTeamsOrgInternalCallback(
  input: HandleTeamsOrgInternalCallbackInput,
): Promise<TeamsOrgCallbackResult> {
  const { callback } = input;
  const signal = input.signal ?? new AbortController().signal;
  const payload = parsePayload(callback.payload);
  if (!payload) {
    return errorResponse(400, "Invalid or missing payload");
  }

  L.debug("Processing org Teams callback", {
    runId: callback.runId,
    status: callback.status,
    conversationId: payload.conversationId,
  });

  if (callback.status === "progress") {
    return await handleProgress({
      payload,
      signal,
    });
  }

  return await handleCompletion({
    db: input.db,
    runId: callback.runId,
    status: callback.status,
    error: callback.error,
    payload,
    getFeatureOverrides: input.getFeatureOverrides,
    formatRunError: input.formatRunError,
    signal,
  });
}

export const handleTeamsOrgInternalCallback$ = command(
  async (
    { get, set },
    callback: InternalRunCallbackEnvelope,
    signal: AbortSignal,
  ): Promise<TeamsOrgInternalCallbackResult> => {
    const result = await handleTeamsOrgInternalCallback({
      db: set(writeDb$),
      callback,
      getFeatureOverrides: (orgId, userId) => {
        return get(userFeatureSwitchOverrides(orgId, userId));
      },
      formatRunError: (params) => {
        return set(formatRunErrorForRunOwner$, params, signal);
      },
      signal,
    });
    return dispatchResultFromResponse(result);
  },
);

export async function handleTeamsOrgInternalCallbackWithoutCcstate(
  db: Db,
  callback: InternalRunCallbackEnvelope,
  signal?: AbortSignal,
): Promise<InternalRunCallbackDispatchResult> {
  const result = await handleTeamsOrgInternalCallback({
    db,
    callback,
    getFeatureOverrides: async (orgId, userId) => {
      return (
        (await loadUserFeatureSwitchContext(db, orgId, userId)).overrides ?? {}
      );
    },
    formatRunError: (params) => {
      return Promise.resolve(
        formatRunErrorForExternalSurface({
          code: "INTERNAL_SERVER_ERROR",
          message: params.errorMessage,
        }),
      );
    },
    signal,
  });
  return dispatchResultFromResponse(result);
}
