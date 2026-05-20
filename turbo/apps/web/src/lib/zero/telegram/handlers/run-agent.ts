import { isRunDispatchError } from "../../../infra/run";
import { createZeroRun } from "../../zero-run-service";
import { isApiError } from "@vm0/api-services/errors";
import { formatRunErrorForExternalSurface } from "@vm0/api-contracts/contracts/errors";
import { logger } from "../../../shared/logger";
import type { TelegramCallbackPayload } from "../../../infra/callback/callback-payloads";
import type { UserInfoOptions } from "../../integration-prompt";
import { resolveModelFirstRouteDescriptor } from "../../model-policy/model-first-route-service";
import { getUserModelPreferenceModel } from "../../model-policy/user-model-preference-service";
import { adaptTelegramTrigger } from "./adapt-telegram-trigger";

const log = logger("telegram:run-agent");

interface RunAgentParams {
  composeId: string;
  agentId: string;
  agentName: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userInfoExtras?: UserInfoOptions;
  botId?: string;
  botUsername?: string | null;
  chatId?: string;
  chatType?: string;
  messageId?: string;
  rootMessageId?: string | null;
  messageThreadId?: string | number | null;
  userId: string;
  orgId: string;
  callbackContext: TelegramCallbackPayload;
  apiStartTime: number;
}

interface RunAgentResult {
  status: "accepted" | "queued" | "failed";
  response?: string;
  runId: string | undefined;
}

async function resolveTelegramRunModelRoute(params: {
  orgId: string;
  userId: string;
}): Promise<
  | {
      modelProviderType: string;
      modelProviderId: string | null;
      modelProviderCredentialScope: string;
      selectedModel: string;
    }
  | undefined
> {
  const selectedModel = await getUserModelPreferenceModel(
    params.orgId,
    params.userId,
  );
  if (!selectedModel) {
    return undefined;
  }
  const route = await resolveModelFirstRouteDescriptor({
    orgId: params.orgId,
    userId: params.userId,
    selectedModel,
  });
  return {
    modelProviderType: route.providerType,
    modelProviderId: route.modelProviderId,
    modelProviderCredentialScope: route.credentialScope,
    selectedModel: route.selectedModel,
  };
}

/**
 * Execute an agent run for Telegram.
 *
 * Thin orchestrator: adapt Telegram-specific params into CreateZeroRunParams,
 * call createZeroRun (which defers dispatch internally), translate errors
 * into Telegram-user-facing strings.
 */
export async function runAgentForTelegram(
  params: RunAgentParams,
): Promise<RunAgentResult> {
  try {
    const modelRoute = await resolveTelegramRunModelRoute({
      orgId: params.orgId,
      userId: params.userId,
    });
    const result = await createZeroRun(
      adaptTelegramTrigger({ ...params, ...(modelRoute ?? {}) }),
    );
    const status: "accepted" | "queued" =
      result.status === "queued" ? "queued" : "accepted";
    log.debug(
      `Run ${result.runId} ${status} for Telegram agent ${params.agentName}`,
    );
    return { status, runId: result.runId };
  } catch (error) {
    return translateTelegramRunError(error, params);
  }
}

function translateTelegramRunError(
  error: unknown,
  params: RunAgentParams,
): RunAgentResult {
  const { composeId, agentName, userId } = params;
  if (isApiError(error)) {
    log.warn(`Pre-run check failed: ${error.code}`, {
      composeId,
      agentName,
      userId,
    });
    return {
      status: "failed",
      response: formatRunErrorForExternalSurface({
        code: error.code,
        message: error.message,
      }),
      runId: undefined,
    };
  }
  const runId = isRunDispatchError(error) ? error.runId : undefined;
  log.error("Failed to create run", { composeId, agentName, userId, error });
  return {
    status: "failed",
    response: formatRunErrorForExternalSurface({
      code: "UNKNOWN",
      message:
        error instanceof Error
          ? error.message
          : "Something went wrong while starting the agent.",
    }),
    runId,
  };
}
