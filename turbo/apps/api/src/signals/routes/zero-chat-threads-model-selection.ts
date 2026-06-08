import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { chatThreadModelSelectionContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { nowDate } from "../external/time";
import { notFound } from "../../lib/error";
import { resolveModelSelectionPin } from "../services/zero-model-selection.service";
import type { RouteEntry } from "../route";

const modelSelectionBody$ = bodyResultOf(
  chatThreadModelSelectionContract.update,
);

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
    const pin = body.data.modelSelection
      ? await resolveModelSelectionPin({
          db: writeDb,
          orgId: auth.orgId,
          userId: auth.userId,
          modelSelection: body.data.modelSelection,
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

    const updated = await writeDb
      .update(chatThreads)
      .set({
        modelProviderId: pin.modelProviderId,
        modelProviderType: pin.modelProviderType,
        modelProviderCredentialScope: pin.modelProviderCredentialScope,
        selectedModel: pin.selectedModel,
        updatedAt: nowDate(),
      })
      .where(
        and(eq(chatThreads.id, params.id), eq(chatThreads.userId, auth.userId)),
      )
      .returning({ id: chatThreads.id });
    signal.throwIfAborted();

    if (updated.length === 0) {
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
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateModelSelectionInner$,
    ),
  },
];
