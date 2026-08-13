import { command } from "ccstate";
import { eq } from "drizzle-orm";
import {
  type CodexServiceTier,
  chatThreadsContract,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
} from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { zeroRuns } from "@okouai/db/schema/zero-run";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { type Db, writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { badRequestMessage, notFound } from "../../lib/error";
import { createChatThread$ } from "../services/zero-chat-thread.service";
import { zeroComposeExists } from "../services/zero-compose-data.service";
import {
  resolveModelSelectionPin,
  validateCodexServiceTier,
} from "../services/zero-model-selection.service";
import { chatThreadModelPinColumns } from "../services/zero-chat-thread-model.service";
import { chatThreadServiceTierFromCodex } from "../services/zero-chat-thread-event.service";
import type { RouteEntry } from "../route-entry";

const createBody$ = bodyResultOf(chatThreadsContract.create);

function modelFirstSelection(selectedModel: string) {
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel,
  };
}

/**
 * Model and priority a caller inherits when it omits them. The model belongs to
 * the run that owns its token; priority belongs to that run's chat thread.
 */
async function inheritedRunChatSettings(
  db: Db,
  runId: string | undefined,
): Promise<{
  readonly selectedModel: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
}> {
  if (!runId) {
    return { selectedModel: null, codexServiceTier: null };
  }

  const [run] = await db
    .select({
      selectedModel: zeroRuns.selectedModel,
      codexServiceTier: chatThreads.codexServiceTier,
    })
    .from(zeroRuns)
    .leftJoin(chatThreads, eq(zeroRuns.chatThreadId, chatThreads.id))
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return {
    selectedModel: run?.selectedModel ?? null,
    codexServiceTier: run?.codexServiceTier ?? null,
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
    zeroComposeExists({
      orgId: auth.orgId,
      composeId: body.data.agentId,
    }),
  );
  signal.throwIfAborted();
  if (!exists) {
    return notFound("Agent not found");
  }

  const writeDb = set(writeDb$);
  const callerRunId =
    auth.tokenType === "sandbox" || auth.tokenType === "zero"
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
      agentComposeId: body.data.agentId,
      title: body.data.title,
      clientThreadId: body.data.clientThreadId,
      eventId: body.data.eventId,
      ...chatThreadModelPinColumns(pin),
      codexServiceTier,
    },
    signal,
  );
  signal.throwIfAborted();

  await publishThreadListChanged(auth.userId);
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

export const zeroChatThreadCreateRoutes: readonly RouteEntry[] = [
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
