import { command } from "ccstate";
import { eq } from "drizzle-orm";
import {
  chatThreadsContract,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { type Db, writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { badRequestMessage, notFound } from "../../lib/error";
import { createChatThread$ } from "../services/zero-chat-thread.service";
import { zeroComposeExists } from "../services/zero-compose-data.service";
import { resolveModelSelectionPin } from "../services/zero-model-selection.service";
import { chatThreadModelPinColumns } from "../services/zero-chat-thread-model.service";
import type { RouteEntry } from "../route-entry";

const createBody$ = bodyResultOf(chatThreadsContract.create);

function modelFirstSelection(selectedModel: string) {
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel,
  };
}

/**
 * Model a caller inherits when it omits `model`: the model of the run that owns
 * its token. Session and PAT callers have no run, so they must send a model.
 */
async function inheritedRunModel(
  db: Db,
  runId: string | undefined,
): Promise<string | null> {
  if (!runId) {
    return null;
  }

  const [run] = await db
    .select({ selectedModel: zeroRuns.selectedModel })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return run?.selectedModel ?? null;
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
  const selectedModel =
    body.data.model ?? (await inheritedRunModel(writeDb, callerRunId));
  signal.throwIfAborted();
  if (!selectedModel) {
    return badRequestMessage("A model selection is required");
  }

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
