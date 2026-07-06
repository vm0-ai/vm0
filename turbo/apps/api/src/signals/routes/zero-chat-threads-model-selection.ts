import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { chatThreadModelSelectionContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { nowDate } from "../external/time";
import { badRequestMessage, notFound } from "../../lib/error";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { appendChatThreadEvent } from "../services/zero-chat-thread-event.service";
import {
  resolveModelFirstProviderAdmission,
  resolveModelSelectionPin,
  type ModelFirstPin,
} from "../services/zero-model-selection.service";
import type { RouteEntry } from "../route-entry";

const modelSelectionBody$ = bodyResultOf(
  chatThreadModelSelectionContract.update,
);

function isCodexFastServiceTierModel(
  model: string | null | undefined,
): boolean {
  const bareModel = model?.startsWith("openai/")
    ? model.slice("openai/".length)
    : model;
  return bareModel === "gpt-5.5";
}

async function validateCodexServiceTierPatch(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly pin: ModelFirstPin;
  readonly codexServiceTier: "fast" | null | undefined;
}) {
  if (params.codexServiceTier !== "fast") {
    return undefined;
  }
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    params.db,
    params.orgId,
    params.userId,
  );
  if (!isFeatureEnabled(FeatureSwitchKey.CodexFastMode, featureSwitchContext)) {
    return badRequestMessage(
      "Codex fast mode is not enabled for this workspace",
    );
  }
  const providerAdmission = await resolveModelFirstProviderAdmission({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    modelPin: params.pin,
    requestedModelProvider: undefined,
  });
  if (providerAdmission.error) {
    return providerAdmission.error;
  }
  if (
    providerAdmission.effectiveModelProvider === "codex-oauth-token" &&
    isCodexFastServiceTierModel(params.pin.selectedModel)
  ) {
    return undefined;
  }
  return badRequestMessage(
    "Codex fast mode is only available for ChatGPT (Codex) GPT-5.5 runs",
  );
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
    const codexServiceTierError = await validateCodexServiceTierPatch({
      db: writeDb,
      orgId: auth.orgId,
      userId: auth.userId,
      pin,
      codexServiceTier: body.data.codexServiceTier,
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
          modelProviderId: pin.modelProviderId,
          modelProviderType: pin.modelProviderType,
          modelProviderCredentialScope: pin.modelProviderCredentialScope,
          selectedModel: pin.selectedModel,
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
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateModelSelectionInner$,
    ),
  },
];
