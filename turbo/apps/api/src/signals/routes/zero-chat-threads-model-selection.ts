import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import {
  chatThreadModelSelectionContract,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
} from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { notFound } from "../../lib/error";
import {
  appendChatThreadEvent,
  chatThreadServiceTierFromCodex,
} from "../services/zero-chat-thread-event.service";
import {
  resolveModelSelectionPin,
  validateCodexServiceTier,
} from "../services/zero-model-selection.service";
import { chatThreadModelPinColumns } from "../services/zero-chat-thread-model.service";
import type { RouteEntry } from "../route-entry";

const modelSelectionBody$ = bodyResultOf(
  chatThreadModelSelectionContract.update,
);

function modelFirstSelection(selectedModel: string) {
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel,
  };
}

const updateModelSelectionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(chatThreadModelSelectionContract.update));
    const body = await get(modelSelectionBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const writeDb = set(writeDb$);
    const modelSelection =
      body.data.model === null ? null : modelFirstSelection(body.data.model);
    const pin = modelSelection
      ? await resolveModelSelectionPin({
          db: writeDb,
          orgId: auth.orgId,
          userId: auth.userId,
          modelSelection,
        })
      : {
          modelProviderId: null,
          modelProviderType: null,
          modelProviderCredentialScope: null,
          selectedModel: null,
        };
    signal.throwIfAborted();

    if ("status" in pin) {
      return pin;
    }
    const codexServiceTierError = await validateCodexServiceTier({
      db: writeDb,
      orgId: auth.orgId,
      userId: auth.userId,
      pin,
      codexServiceTier: body.data.codexServiceTier ?? null,
    });
    signal.throwIfAborted();
    if (codexServiceTierError) {
      return codexServiceTierError;
    }

    const updated = await writeDb.transaction(async (tx) => {
      const updatedAt = nowDate();
      const [thread] = await tx
        .update(chatThreads)
        .set({
          ...chatThreadModelPinColumns(pin),
          codexServiceTier: body.data.codexServiceTier ?? null,
          updatedAt,
        })
        .where(
          and(
            eq(chatThreads.id, params.id),
            eq(chatThreads.userId, auth.userId),
          ),
        )
        .returning({
          id: chatThreads.id,
          agentComposeId: chatThreads.agentComposeId,
        });
      if (!thread) {
        return false;
      }
      await appendChatThreadEvent(tx, {
        kind: "model_selection_updated",
        userId: auth.userId,
        orgId: auth.orgId,
        chatThreadId: thread.id,
        agentComposeId: thread.agentComposeId,
        eventId: body.data.eventId,
        selectedModel: pin.selectedModel,
        createdAt: updatedAt,
      });
      await appendChatThreadEvent(tx, {
        kind: "service_tier_updated",
        userId: auth.userId,
        orgId: auth.orgId,
        chatThreadId: thread.id,
        agentComposeId: thread.agentComposeId,
        eventId: body.data.serviceTierEventId,
        serviceTier: chatThreadServiceTierFromCodex(
          body.data.codexServiceTier ?? null,
        ),
        createdAt: updatedAt,
      });
      return true;
    });
    signal.throwIfAborted();

    if (!updated) {
      return notFound("Chat thread not found");
    }

    await publishThreadListChanged(auth.userId);
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

export const zeroChatThreadModelSelectionRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadModelSelectionContract.update,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      updateModelSelectionInner$,
    ),
  },
];
