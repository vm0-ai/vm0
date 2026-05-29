import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";

import { badRequestMessage, providerDeleted } from "../../lib/error";
import type { Db } from "../external/db";
import { nowDate } from "../external/time";
import { ensureOrgModelPolicies } from "./zero-model-policy.service";
import { checkOrgCreditsForRunAdmission } from "./zero-run-admission.service";

const ORG_SENTINEL_USER_ID = "__org__";
export const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

export interface ModelFirstPin {
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

interface ModelSelectionRequest {
  readonly modelProviderId: string;
  readonly selectedModel: string;
}

type IncomingModelSelection = ModelSelectionRequest | null | undefined;

export interface ZeroRunModelSelection {
  readonly modelProvider: string | null;
  readonly modelProviderId: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

function parseModelProviderCredentialScope(
  value: string | null,
): ModelProviderCredentialScope | null {
  if (value === null || value === "org" || value === "member") {
    return value;
  }
  throw new Error(`Unknown model provider credential scope "${value}"`);
}

function modelOnlyModelFirstPin(selectedModel: string | null): ModelFirstPin {
  return {
    modelProviderId: null,
    modelProviderType: null,
    modelProviderCredentialScope: null,
    selectedModel,
  };
}

export async function resolveDefaultModelFirstPin(
  db: Db,
  orgId: string,
  userId: string,
): Promise<ModelFirstPin> {
  const [preference] = await db
    .select({ selectedModel: orgMembersMetadata.selectedModel })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);

  const preferredModel = preference?.selectedModel ?? null;
  const [policy] = await db
    .select({
      model: orgModelPolicies.model,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
    })
    .from(orgModelPolicies)
    .where(
      preferredModel
        ? and(
            eq(orgModelPolicies.orgId, orgId),
            eq(orgModelPolicies.model, preferredModel),
          )
        : and(
            eq(orgModelPolicies.orgId, orgId),
            eq(orgModelPolicies.isDefault, true),
          ),
    )
    .limit(1);

  if (!policy && preferredModel) {
    return resolveDefaultModelFirstPin(db, orgId, "__no_preference__");
  }

  if (!policy) {
    return {
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: null,
    };
  }

  return {
    modelProviderId: policy.modelProviderId ?? null,
    modelProviderType: policy.defaultProviderType,
    modelProviderCredentialScope: parseModelProviderCredentialScope(
      policy.credentialScope,
    ),
    selectedModel: policy.model,
  };
}

export function zeroRunModelSelectionFromPin(
  modelPin: ModelFirstPin,
  effectiveModelProvider: string | null | undefined,
): ZeroRunModelSelection {
  return {
    modelProvider: effectiveModelProvider ?? null,
    modelProviderId: modelPin.modelProviderId,
    modelProviderCredentialScope: modelPin.modelProviderCredentialScope,
    selectedModel: modelPin.selectedModel,
  };
}

export interface ModelFirstRunSelection {
  readonly modelPin: ModelFirstPin;
  readonly effectiveModelProvider: string | null | undefined;
  readonly zeroRunModelSelection: ZeroRunModelSelection;
}

export async function resolveDefaultModelFirstRunSelection(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly requestedModelProvider?: string;
}): Promise<
  | ModelFirstRunSelection
  | NonNullable<Awaited<ReturnType<typeof checkOrgCreditsForRunAdmission>>>
> {
  const modelPin = await resolveDefaultModelFirstPin(
    params.db,
    params.orgId,
    params.userId,
  );
  const providerAdmission = await resolveModelFirstProviderAdmission({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    modelPin,
    requestedModelProvider: params.requestedModelProvider,
  });
  if (providerAdmission.error) {
    return providerAdmission.error;
  }
  return {
    modelPin,
    effectiveModelProvider: providerAdmission.effectiveModelProvider,
    zeroRunModelSelection: zeroRunModelSelectionFromPin(
      modelPin,
      providerAdmission.effectiveModelProvider,
    ),
  };
}

export async function modelProviderPinAvailable(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderId: string;
}): Promise<boolean> {
  const [provider] = await params.db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.id, params.modelProviderId),
        eq(modelProviders.orgId, params.orgId),
        or(
          eq(modelProviders.userId, params.userId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      ),
    )
    .limit(1);
  return provider !== undefined;
}

export async function resolveModelSelectionPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelSelection: ModelSelectionRequest;
}): Promise<ModelFirstPin | ReturnType<typeof badRequestMessage>> {
  const { db, orgId, userId, modelSelection } = params;
  if (modelSelection.modelProviderId !== MODEL_FIRST_SELECTION_PROVIDER_ID) {
    const available = await modelProviderPinAvailable({
      db,
      orgId,
      userId,
      modelProviderId: modelSelection.modelProviderId,
    });
    if (!available) {
      return badRequestMessage("Unknown model provider for this workspace");
    }
    return {
      modelProviderId: modelSelection.modelProviderId,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: modelSelection.selectedModel,
    };
  }

  await ensureOrgModelPolicies(db, orgId, userId);
  const [policy] = await db
    .select({
      model: orgModelPolicies.model,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
    })
    .from(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, orgId),
        eq(orgModelPolicies.model, modelSelection.selectedModel),
      ),
    )
    .limit(1);
  if (!policy) {
    return {
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: modelSelection.selectedModel,
    };
  }
  return {
    modelProviderId: policy.modelProviderId ?? null,
    modelProviderType: policy.defaultProviderType,
    modelProviderCredentialScope: parseModelProviderCredentialScope(
      policy.credentialScope,
    ),
    selectedModel: policy.model,
  };
}

async function getStoredThreadModelPin(
  db: Db,
  threadId: string,
): Promise<ModelFirstPin | null> {
  const [thread] = await db
    .select({ selectedModel: chatThreads.selectedModel })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!thread?.selectedModel) {
    return null;
  }
  return modelOnlyModelFirstPin(thread.selectedModel);
}

async function getFirstRunModelPin(
  db: Db,
  threadId: string,
): Promise<ModelFirstPin | null> {
  const [run] = await db
    .select({ selectedModel: zeroRuns.selectedModel })
    .from(chatMessages)
    .innerJoin(zeroRuns, eq(zeroRuns.id, chatMessages.runId))
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        eq(chatMessages.role, "user"),
        isNotNull(chatMessages.runId),
        isNotNull(zeroRuns.selectedModel),
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .limit(1);
  if (!run?.selectedModel) {
    return null;
  }
  return modelOnlyModelFirstPin(run.selectedModel);
}

export async function existingModelFirstThreadPin(
  db: Db,
  threadId: string,
): Promise<ModelFirstPin | null> {
  return (
    (await getStoredThreadModelPin(db, threadId)) ??
    (await getFirstRunModelPin(db, threadId))
  );
}

async function resolveStoredModelFirstPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly pin: ModelFirstPin;
}): Promise<
  | ModelFirstPin
  | ReturnType<typeof providerDeleted>
  | ReturnType<typeof badRequestMessage>
> {
  if (!params.pin.selectedModel) {
    return params.pin;
  }
  if (params.pin.modelProviderId) {
    const available = await modelProviderPinAvailable({
      db: params.db,
      orgId: params.orgId,
      userId: params.userId,
      modelProviderId: params.pin.modelProviderId,
    });
    if (!available) {
      return providerDeleted();
    }
    return params.pin;
  }
  if (params.pin.modelProviderType || params.pin.modelProviderCredentialScope) {
    return params.pin;
  }
  return resolveModelSelectionPin({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    modelSelection: {
      modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
      selectedModel: params.pin.selectedModel,
    },
  });
}

async function persistThreadPinIfUnset(
  db: Db,
  threadId: string,
  pin: ModelFirstPin,
): Promise<ModelFirstPin> {
  if (!pin.selectedModel) {
    return pin;
  }
  await db
    .update(chatThreads)
    .set({
      ...modelOnlyModelFirstPin(pin.selectedModel),
      updatedAt: nowDate(),
    })
    .where(and(eq(chatThreads.id, threadId), isNull(chatThreads.selectedModel)))
    .returning({ selectedModel: chatThreads.selectedModel });
  return pin;
}

export async function resolveChatRunModelPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly modelSelection: IncomingModelSelection;
  readonly forceNewSession: boolean;
}): Promise<
  | ModelFirstPin
  | ReturnType<typeof providerDeleted>
  | ReturnType<typeof badRequestMessage>
> {
  const existing = params.forceNewSession
    ? null
    : await existingModelFirstThreadPin(params.db, params.threadId);
  if (existing) {
    const pin = await resolveStoredModelFirstPin({
      db: params.db,
      orgId: params.orgId,
      userId: params.userId,
      pin: existing,
    });
    if ("status" in pin) {
      return pin;
    }
    return persistThreadPinIfUnset(params.db, params.threadId, pin);
  }

  const pin = params.modelSelection
    ? await resolveModelSelectionPin({
        db: params.db,
        orgId: params.orgId,
        userId: params.userId,
        modelSelection: params.modelSelection,
      })
    : await resolveDefaultModelFirstPin(params.db, params.orgId, params.userId);
  if ("status" in pin) {
    return pin;
  }
  return persistThreadPinIfUnset(params.db, params.threadId, pin);
}

async function resolveEffectiveModelProviderType(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelPin: ModelFirstPin;
  readonly requestedModelProvider: string | undefined;
}): Promise<string | null | undefined> {
  if (params.modelPin.modelProviderType) {
    return params.modelPin.modelProviderType;
  }
  if (!params.modelPin.modelProviderId) {
    return params.requestedModelProvider;
  }

  const [provider] = await params.db
    .select({ type: modelProviders.type })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.id, params.modelPin.modelProviderId),
        eq(modelProviders.orgId, params.orgId),
        or(
          eq(modelProviders.userId, params.userId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      ),
    )
    .limit(1);

  return provider?.type ?? params.requestedModelProvider;
}

export async function resolveModelFirstProviderAdmission(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelPin: ModelFirstPin;
  readonly requestedModelProvider: string | undefined;
}): Promise<{
  readonly effectiveModelProvider: string | null | undefined;
  readonly error: Awaited<ReturnType<typeof checkOrgCreditsForRunAdmission>>;
}> {
  const effectiveModelProvider =
    await resolveEffectiveModelProviderType(params);
  const error = await checkOrgCreditsForRunAdmission({
    db: params.db,
    orgId: params.orgId,
    modelProviderType: effectiveModelProvider,
  });
  return { effectiveModelProvider, error };
}
