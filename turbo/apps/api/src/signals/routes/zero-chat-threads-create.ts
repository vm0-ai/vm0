import { command } from "ccstate";
import {
  chatThreadsContract,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
} from "@vm0/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { badRequestMessage, notFound } from "../../lib/error";
import { createChatThread$ } from "../services/zero-chat-thread.service";
import { zeroComposeExists } from "../services/zero-compose-data.service";
import { resolveModelSelectionPin } from "../services/zero-model-selection.service";
import type { RouteEntry } from "../route-entry";

const createBody$ = bodyResultOf(chatThreadsContract.create);

function modelFirstSelection(selectedModel: string) {
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel,
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

  const modelSelection =
    body.data.modelSelection ??
    (body.data.model ? modelFirstSelection(body.data.model) : undefined);
  if (!modelSelection) {
    return badRequestMessage("A model selection is required");
  }

  const pin = await resolveModelSelectionPin({
    db: set(writeDb$),
    orgId: auth.orgId,
    userId: auth.userId,
    modelSelection,
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
      modelProviderId: pin.modelProviderId,
      modelProviderType: pin.modelProviderType,
      modelProviderCredentialScope: pin.modelProviderCredentialScope,
      selectedModel: pin.selectedModel,
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
    },
  };
});

export const zeroChatThreadCreateRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadsContract.create,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      createInner$,
    ),
  },
];
