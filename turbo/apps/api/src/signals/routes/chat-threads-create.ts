import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  type CodexServiceTier,
  chatThreadsContract,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  isImageModelId,
  type ImageModelId,
} from "@okouai/api-contracts/contracts/image-models";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { type Db, writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { badRequestMessage, notFound } from "../../lib/error";
import { createChatThread$ } from "../services/chat-thread.service";
import { agentExistsInOrg } from "../services/agent-deletion.service";
import { loadNewChatThreadMediaModels } from "../services/chat-thread-media-model.service";
import {
  resolveModelSelectionPin,
  validateCodexServiceTier,
} from "../services/model-selection.service";
import { chatThreadModelPinColumns } from "../services/chat-thread-model.service";
import { chatThreadServiceTierFromCodex } from "../services/chat-thread-event.service";
import type { RouteEntry } from "../route-entry";

const createBody$ = bodyResultOf(chatThreadsContract.create);

function modelFirstSelection(selectedModel: string) {
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel,
  };
}

/**
 * Model, priority, and media models a caller inherits when it omits them. The
 * model belongs to the run that owns its token; the other settings belong to
 * that run's chat thread.
 */
async function inheritedRunChatSettings(
  db: Db,
  runId: string | undefined,
): Promise<{
  readonly selectedModel: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly selectedVideoModel: string | null;
  readonly selectedImageModel: ImageModelId | null;
}> {
  if (!runId) {
    return {
      selectedModel: null,
      codexServiceTier: null,
      selectedVideoModel: null,
      selectedImageModel: null,
    };
  }

  const [run] = await db
    .select({
      selectedModel: agentRuns.selectedModel,
      codexServiceTier: chatThreads.codexServiceTier,
      selectedVideoModel: chatThreads.selectedVideoModel,
      selectedImageModel: chatThreads.selectedImageModel,
    })
    .from(agentRuns)
    .leftJoin(chatThreads, eq(agentRuns.chatThreadId, chatThreads.id))
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  return {
    selectedModel: run?.selectedModel ?? null,
    codexServiceTier: run?.codexServiceTier ?? null,
    selectedVideoModel: run?.selectedVideoModel ?? null,
    selectedImageModel: isImageModelId(run?.selectedImageModel)
      ? run.selectedImageModel
      : null,
  };
}

const createInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(createBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const exists = await get(
    agentExistsInOrg({
      orgId: auth.orgId,
      agentId: body.data.agentId,
    }),
  );
  signal.throwIfAborted();
  if (!exists) {
    return notFound("Agent not found");
  }

  const writeDb = set(writeDb$);
  const connectorSelections = body.data.connectorSelections ?? [];
  const callerRunId =
    auth.tokenType === "sandbox" || auth.tokenType === "agent"
      ? auth.runId
      : undefined;
  const inherited = await inheritedRunChatSettings(writeDb, callerRunId);
  signal.throwIfAborted();
  const selectedModel = body.data.model ?? inherited.selectedModel;
  if (!selectedModel) {
    return badRequestMessage("A model selection is required");
  }
  const codexServiceTier: CodexServiceTier | null =
    body.data.serviceTier === undefined
      ? inherited.codexServiceTier
      : body.data.serviceTier === "priority"
        ? "fast"
        : null;
  // Explicit request, then what the caller's own thread pinned, then the
  // member and catalog defaults. The last step is what keeps a thread from
  // following a default the member changes after this thread exists.
  const mediaDefaults = await loadNewChatThreadMediaModels(writeDb, {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  signal.throwIfAborted();
  const selectedVideoModel =
    body.data.videoModel ??
    inherited.selectedVideoModel ??
    mediaDefaults.selectedVideoModel;
  const selectedImageModel =
    body.data.imageModel ??
    inherited.selectedImageModel ??
    mediaDefaults.selectedImageModel;

  const pin = await resolveModelSelectionPin({
    db: writeDb,
    orgId: auth.orgId,
    userId: auth.userId,
    modelSelection: modelFirstSelection(selectedModel),
  });
  signal.throwIfAborted();
  if ("status" in pin) {
    return pin;
  }
  const codexServiceTierError = await validateCodexServiceTier({
    db: writeDb,
    orgId: auth.orgId,
    userId: auth.userId,
    pin,
    codexServiceTier,
  });
  signal.throwIfAborted();
  if (codexServiceTierError) {
    return codexServiceTierError;
  }

  const thread = await set(
    createChatThread$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      agentId: body.data.agentId,
      title: body.data.title,
      clientThreadId: body.data.clientThreadId,
      eventId: body.data.eventId,
      ...chatThreadModelPinColumns(pin),
      codexServiceTier,
      selectedVideoModel,
      selectedImageModel,
      connectorSelections,
    },
    signal,
  );
  signal.throwIfAborted();
  if (thread.kind === "invalid_connector_selection") {
    return badRequestMessage(thread.message);
  }

  await publishThreadListChanged({ userId: auth.userId, orgId: auth.orgId });
  signal.throwIfAborted();

  return {
    status: 201 as const,
    body: {
      id: thread.id,
      title: body.data.title ?? null,
      createdAt: thread.createdAt.toISOString(),
      selectedModel,
      serviceTier: chatThreadServiceTierFromCodex(codexServiceTier),
    },
  };
});

export const chatThreadCreateRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadsContract.create,
    handler: authRoute(
      {
        requiredCapability: "chat-thread:write",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      createInner$,
    ),
  },
];
