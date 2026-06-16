import { command, computed, type Computed } from "ccstate";
import {
  CHAT_RUN_TRANSIENT_ERROR_MESSAGE,
  formatRunErrorForExternalSurface,
  isActionableRunError,
  isClaudeCodeAuthenticationCredentialsError,
  isGenericRunErrorForDisplay,
} from "@vm0/api-contracts/contracts/errors";
import {
  modelProviderCredentialScopeSchema,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { asc, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";

const REPORT_ERROR_STREAK_THRESHOLD = 2;
const CHAT_RUN_REPORTABLE_ERROR_MESSAGE = "An unexpected error occurred.";

interface RunErrorProviderContext {
  readonly userId: string;
  readonly orgId: string;
  readonly modelProviderType: ModelProviderType | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
}

interface FormatRunErrorLikeWebMessageParams {
  readonly chatThreadId?: string | null;
  readonly runId: string;
  readonly errorMessage: string;
  readonly modelProviderType?: ModelProviderType | null;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope | null;
  readonly canManageOrgModelProviders?: boolean;
}

function buildReportableErrorMessage(runId: string): string {
  return `${CHAT_RUN_REPORTABLE_ERROR_MESSAGE} [Report this issue](/runs/${encodeURIComponent(runId)}/report-error)`;
}

function buildModelProvidersUrl(): string {
  const appUrl = env("APP_URL").replace(/\/$/u, "");
  return `${appUrl}/?settings=providers`;
}

function buildPersonalModelProvidersUrl(): string {
  const appUrl = env("APP_URL").replace(/\/$/u, "");
  return `${appUrl}/?settings=model`;
}

function buildClaudeCodeCredentialRecoveryUrl(params: {
  readonly modelProviderType: ModelProviderType | null | undefined;
  readonly modelProviderCredentialScope:
    | ModelProviderCredentialScope
    | null
    | undefined;
}): string {
  if (
    params.modelProviderType === "claude-code-oauth-token" &&
    params.modelProviderCredentialScope === "member"
  ) {
    return buildPersonalModelProvidersUrl();
  }
  return buildModelProvidersUrl();
}

function formatLatestSessionProviderType(
  value: string | null,
): ModelProviderType | null {
  if (value === null) {
    return null;
  }
  const parsed = modelProviderTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function formatRunModelProviderCredentialScope(
  value: string | null,
): ModelProviderCredentialScope | null {
  if (value === null) {
    return null;
  }
  const parsed = modelProviderCredentialScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function genericErrorStreakForRun(params: {
  readonly chatThreadId: string;
  readonly runId: string;
  readonly currentErrorMessage: string;
}): Computed<Promise<number>> {
  return computed(async (get): Promise<number> => {
    const rows = await get(db$)
      .select({
        runId: zeroRuns.id,
        error: agentRuns.error,
      })
      .from(zeroRuns)
      .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(zeroRuns.chatThreadId, params.chatThreadId))
      .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id));

    let streak = 0;
    for (const row of rows) {
      const errorMessage =
        row.runId === params.runId ? params.currentErrorMessage : row.error;
      if (!errorMessage?.trim() || isActionableRunError(errorMessage)) {
        streak = 0;
      } else {
        streak += 1;
      }

      if (row.runId === params.runId) {
        return streak;
      }
    }

    return 1;
  });
}

function runErrorProviderContext(
  runId: string,
): Computed<Promise<RunErrorProviderContext | undefined>> {
  return computed(async (get): Promise<RunErrorProviderContext | undefined> => {
    const [run] = await get(db$)
      .select({
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        modelProviderType: zeroRuns.modelProvider,
        modelProviderCredentialScope: zeroRuns.modelProviderCredentialScope,
      })
      .from(agentRuns)
      .leftJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (!run) {
      return undefined;
    }

    return {
      userId: run.userId,
      orgId: run.orgId,
      modelProviderType: formatLatestSessionProviderType(run.modelProviderType),
      modelProviderCredentialScope: formatRunModelProviderCredentialScope(
        run.modelProviderCredentialScope,
      ),
    };
  });
}

function formatRunErrorLikeWebMessage(
  params: FormatRunErrorLikeWebMessageParams,
): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    const errorMessage = params.errorMessage.trim() || "Run failed";
    const providerContext =
      params.modelProviderType !== undefined &&
      params.modelProviderCredentialScope !== undefined
        ? undefined
        : await get(runErrorProviderContext(params.runId));
    const modelProviderType =
      params.modelProviderType !== undefined
        ? params.modelProviderType
        : providerContext?.modelProviderType;
    const modelProviderCredentialScope =
      params.modelProviderCredentialScope !== undefined
        ? params.modelProviderCredentialScope
        : providerContext?.modelProviderCredentialScope;
    const displayErrorMessage = formatRunErrorForExternalSurface({
      code: "INTERNAL_SERVER_ERROR",
      message: errorMessage,
      claudeCodeCredentialRecovery: {
        modelProviderType,
        modelProviderCredentialScope,
        canManageOrgModelProviders: params.canManageOrgModelProviders ?? false,
        modelProvidersUrl: buildClaudeCodeCredentialRecoveryUrl({
          modelProviderType,
          modelProviderCredentialScope,
        }),
      },
    });
    if (
      !isGenericRunErrorForDisplay(errorMessage) ||
      displayErrorMessage !== CHAT_RUN_TRANSIENT_ERROR_MESSAGE
    ) {
      return displayErrorMessage;
    }
    if (!params.chatThreadId) {
      return displayErrorMessage;
    }

    const streak = await get(
      genericErrorStreakForRun({
        chatThreadId: params.chatThreadId,
        runId: params.runId,
        currentErrorMessage: errorMessage,
      }),
    );

    return streak >= REPORT_ERROR_STREAK_THRESHOLD
      ? buildReportableErrorMessage(params.runId)
      : displayErrorMessage;
  });
}

export const formatRunErrorForRunOwner$ = command(
  async (
    { get, set },
    params: Omit<
      FormatRunErrorLikeWebMessageParams,
      "modelProviderType" | "modelProviderCredentialScope"
    >,
    signal: AbortSignal,
  ): Promise<string> => {
    const providerContext = await get(runErrorProviderContext(params.runId));
    signal.throwIfAborted();

    let canManageOrgModelProviders = params.canManageOrgModelProviders ?? false;
    if (
      params.canManageOrgModelProviders === undefined &&
      providerContext?.modelProviderType === "anthropic-api-key" &&
      providerContext.modelProviderCredentialScope === "org" &&
      isClaudeCodeAuthenticationCredentialsError(params.errorMessage)
    ) {
      const membership = await set(
        getMemberRoleAndUpdateCache$,
        providerContext.orgId,
        providerContext.userId,
        signal,
      );
      signal.throwIfAborted();
      canManageOrgModelProviders = membership?.role === "admin";
    }

    return await get(
      formatRunErrorLikeWebMessage({
        ...params,
        modelProviderType: providerContext?.modelProviderType ?? null,
        modelProviderCredentialScope:
          providerContext?.modelProviderCredentialScope ?? null,
        canManageOrgModelProviders,
      }),
    );
  },
);
