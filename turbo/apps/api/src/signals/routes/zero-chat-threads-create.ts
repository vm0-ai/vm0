import { command } from "ccstate";
import {
  chatThreadsContract,
  type CodexServiceTier,
} from "@vm0/api-contracts/contracts/chat-threads";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { badRequestMessage, notFound } from "../../lib/error";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { createChatThread$ } from "../services/zero-chat-thread.service";
import { zeroComposeExists } from "../services/zero-compose-data.service";
import {
  resolveModelFirstProviderAdmission,
  resolveModelSelectionPin,
  type ModelFirstPin,
} from "../services/zero-model-selection.service";
import type { RouteEntry } from "../route-entry";

const createBody$ = bodyResultOf(chatThreadsContract.create);

function isCodexFastServiceTierModel(
  model: string | null | undefined,
): boolean {
  const bareModel = model?.startsWith("openai/")
    ? model.slice("openai/".length)
    : model;
  return bareModel === "gpt-5.5";
}

async function validateCodexServiceTierCreate(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly pin: ModelFirstPin;
  readonly codexServiceTier: CodexServiceTier | null | undefined;
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
    "Codex fast mode is only available for ChatGPT (Codex) GPT 5.5 runs",
  );
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
  const pin = await resolveModelSelectionPin({
    db: writeDb,
    orgId: auth.orgId,
    userId: auth.userId,
    modelSelection: body.data.modelSelection,
  });
  signal.throwIfAborted();
  if ("status" in pin) {
    return pin;
  }
  const codexServiceTierError = await validateCodexServiceTierCreate({
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
      codexServiceTier: body.data.codexServiceTier ?? null,
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
