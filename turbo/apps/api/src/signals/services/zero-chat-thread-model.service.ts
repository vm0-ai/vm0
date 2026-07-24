import type { CodexServiceTier } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { and, eq } from "drizzle-orm";

import { badRequestMessage } from "../../lib/error";
import type { Db } from "../external/db";
import {
  publishChatThreadDetailChangedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { nowDate } from "../external/time";
import {
  appendChatThreadEvent,
  chatThreadServiceTierFromCodex,
} from "./zero-chat-thread-event.service";
import {
  isCodexFastServiceTierSupported,
  resolveDefaultModelFirstPin,
  resolveModelFirstProviderAdmission,
  resolvePersistedModelFirstRoute,
  type ModelFirstPin,
} from "./zero-model-selection.service";

export function chatThreadModelPinColumns(pin: ModelFirstPin): {
  readonly modelProviderId: null;
  readonly modelProviderType: null;
  readonly modelProviderCredentialScope: null;
  readonly selectedModel: string | null;
} {
  return {
    modelProviderId: null,
    modelProviderType: null,
    modelProviderCredentialScope: null,
    selectedModel: pin.selectedModel,
  };
}

type ModelFirstProviderAdmission = Awaited<
  ReturnType<typeof resolveModelFirstProviderAdmission>
>;
type ChatThreadModelTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

interface ResolvePersistedChatThreadModelParams {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly fallbackSelectedModel?: string | null;
  readonly requestedCodexServiceTier?: CodexServiceTier;
  readonly persistRequestedCodexServiceTier: boolean;
  readonly codexFastModeEnabled: boolean;
}

interface LockedChatThreadModel {
  readonly selectedModel: string | null;
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly agentComposeId: string;
}

export interface ResolvedPersistedChatThreadModel {
  readonly pin: ModelFirstPin;
  readonly providerAdmission: ModelFirstProviderAdmission;
  readonly runCodexServiceTier: "fast" | undefined;
  readonly persistedCodexServiceTier: CodexServiceTier | null;
  readonly selectedModelChanged: boolean;
}

interface PersistedChatThreadModelTransactionResult {
  readonly resolved:
    | ResolvedPersistedChatThreadModel
    | ReturnType<typeof badRequestMessage>
    | null;
  readonly publishThreadList: boolean;
  readonly publishThreadDetail: boolean;
}

type CodexTierResolution =
  | {
      readonly kind: "error";
      readonly error: ReturnType<typeof badRequestMessage>;
    }
  | {
      readonly kind: "ok";
      readonly runCodexServiceTier: "fast" | undefined;
      readonly persistedCodexServiceTier: CodexServiceTier | null;
      readonly tierChanged: boolean;
    };

function transactionResultWithoutPublish(
  resolved: PersistedChatThreadModelTransactionResult["resolved"],
): PersistedChatThreadModelTransactionResult {
  return {
    resolved,
    publishThreadList: false,
    publishThreadDetail: false,
  };
}

async function loadLockedChatThreadModel(
  tx: ChatThreadModelTransaction,
  params: Pick<ResolvePersistedChatThreadModelParams, "threadId" | "userId">,
): Promise<LockedChatThreadModel | undefined> {
  const [thread] = await tx
    .select({
      selectedModel: chatThreads.selectedModel,
      modelProviderId: chatThreads.modelProviderId,
      modelProviderType: chatThreads.modelProviderType,
      modelProviderCredentialScope: chatThreads.modelProviderCredentialScope,
      codexServiceTier: chatThreads.codexServiceTier,
      agentComposeId: chatThreads.agentComposeId,
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, params.threadId),
        eq(chatThreads.userId, params.userId),
      ),
    )
    .limit(1)
    .for("update");
  return thread;
}

function resolveCodexTier(args: {
  readonly persistedTier: CodexServiceTier | null;
  readonly requestedTier: CodexServiceTier | undefined;
  readonly persistRequestedTier: boolean;
  readonly fastSupported: boolean;
  readonly selectedModelChanged: boolean;
}): CodexTierResolution {
  const persistedFastNeedsNormalization =
    args.persistedTier === "fast" && !args.fastSupported;
  if (
    args.persistRequestedTier &&
    args.requestedTier === "fast" &&
    !args.fastSupported &&
    !args.selectedModelChanged &&
    !persistedFastNeedsNormalization
  ) {
    return {
      kind: "error",
      error: badRequestMessage(
        "Codex fast mode is not available for the selected model route",
      ),
    };
  }

  const compatibleStoredTier =
    args.persistedTier === "fast" && args.fastSupported ? "fast" : null;
  const runCodexServiceTier = args.persistRequestedTier
    ? args.requestedTier === "fast" && args.fastSupported
      ? "fast"
      : undefined
    : (compatibleStoredTier ?? undefined);
  const persistedCodexServiceTier = args.persistRequestedTier
    ? (runCodexServiceTier ?? null)
    : compatibleStoredTier;
  return {
    kind: "ok",
    runCodexServiceTier,
    persistedCodexServiceTier,
    tierChanged: persistedCodexServiceTier !== args.persistedTier,
  };
}

function legacyProviderPinPresent(thread: LockedChatThreadModel): boolean {
  return (
    thread.modelProviderId !== null ||
    thread.modelProviderType !== null ||
    thread.modelProviderCredentialScope !== null
  );
}

async function persistReconciledChatThreadModel(args: {
  readonly tx: ChatThreadModelTransaction;
  readonly params: ResolvePersistedChatThreadModelParams;
  readonly thread: LockedChatThreadModel;
  readonly pin: ModelFirstPin;
  readonly persistedCodexServiceTier: CodexServiceTier | null;
  readonly selectedModelChanged: boolean;
  readonly tierChanged: boolean;
}): Promise<void> {
  if (
    !args.selectedModelChanged &&
    !args.tierChanged &&
    !legacyProviderPinPresent(args.thread)
  ) {
    return;
  }

  const updatedAt = nowDate();
  await args.tx
    .update(chatThreads)
    .set({
      ...chatThreadModelPinColumns(args.pin),
      codexServiceTier: args.persistedCodexServiceTier,
      updatedAt,
    })
    .where(
      and(
        eq(chatThreads.id, args.params.threadId),
        eq(chatThreads.userId, args.params.userId),
      ),
    );
  if (args.selectedModelChanged) {
    await appendChatThreadEvent(args.tx, {
      kind: "model_selection_updated",
      userId: args.params.userId,
      orgId: args.params.orgId,
      chatThreadId: args.params.threadId,
      agentComposeId: args.thread.agentComposeId,
      selectedModel: args.pin.selectedModel,
      createdAt: updatedAt,
    });
  }
  if (args.tierChanged) {
    await appendChatThreadEvent(args.tx, {
      kind: "service_tier_updated",
      userId: args.params.userId,
      orgId: args.params.orgId,
      chatThreadId: args.params.threadId,
      agentComposeId: args.thread.agentComposeId,
      serviceTier: chatThreadServiceTierFromCodex(
        args.persistedCodexServiceTier,
      ),
      createdAt: updatedAt,
    });
  }
}

async function resolvePersistedChatThreadModelInTransaction(
  tx: ChatThreadModelTransaction,
  params: ResolvePersistedChatThreadModelParams,
): Promise<PersistedChatThreadModelTransactionResult> {
  const thread = await loadLockedChatThreadModel(tx, params);
  if (!thread) {
    return transactionResultWithoutPublish(null);
  }

  const modelResolution = await resolvePersistedModelFirstRoute({
    db: tx,
    orgId: params.orgId,
    userId: params.userId,
    selectedModel: thread.selectedModel ?? params.fallbackSelectedModel ?? null,
  });
  if (!modelResolution.route) {
    return transactionResultWithoutPublish(
      badRequestMessage(
        "No valid model route is configured for this workspace",
      ),
    );
  }

  const pin: ModelFirstPin = {
    modelProviderId: modelResolution.route.modelProviderId,
    modelProviderType: modelResolution.route.modelProviderType,
    modelProviderCredentialScope:
      modelResolution.route.modelProviderCredentialScope,
    selectedModel: modelResolution.route.selectedModel,
  };
  const providerAdmission = await resolveModelFirstProviderAdmission({
    db: tx,
    orgId: params.orgId,
    userId: params.userId,
    modelPin: pin,
    requestedModelProvider: undefined,
  });
  const selectedModelChanged =
    modelResolution.selectedModelChanged ||
    thread.selectedModel !== pin.selectedModel;
  const tier = resolveCodexTier({
    persistedTier: thread.codexServiceTier,
    requestedTier: params.requestedCodexServiceTier,
    persistRequestedTier: params.persistRequestedCodexServiceTier,
    fastSupported: isCodexFastServiceTierSupported({
      selectedModel: pin.selectedModel,
      effectiveModelProvider: providerAdmission.effectiveModelProvider,
      codexFastModeEnabled: params.codexFastModeEnabled,
    }),
    selectedModelChanged,
  });
  if (tier.kind === "error") {
    return transactionResultWithoutPublish(tier.error);
  }

  await persistReconciledChatThreadModel({
    tx,
    params,
    thread,
    pin,
    persistedCodexServiceTier: tier.persistedCodexServiceTier,
    selectedModelChanged,
    tierChanged: tier.tierChanged,
  });
  return {
    resolved: {
      pin,
      providerAdmission,
      runCodexServiceTier: tier.runCodexServiceTier,
      persistedCodexServiceTier: tier.persistedCodexServiceTier,
      selectedModelChanged,
    },
    publishThreadList: selectedModelChanged || tier.tierChanged,
    publishThreadDetail: tier.tierChanged,
  };
}

export async function resolvePersistedChatThreadModel(
  params: ResolvePersistedChatThreadModelParams,
): Promise<
  ResolvedPersistedChatThreadModel | ReturnType<typeof badRequestMessage> | null
> {
  const result = await params.db.transaction((tx) => {
    return resolvePersistedChatThreadModelInTransaction(tx, params);
  });

  await Promise.all([
    result.publishThreadList
      ? publishThreadListChangedSafely(params.userId)
      : Promise.resolve(),
    result.publishThreadDetail
      ? publishChatThreadDetailChangedSafely(params.userId, params.threadId)
      : Promise.resolve(),
  ]);
  return result.resolved;
}

export async function resolveRequiredDefaultChatThreadModelPin(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<ModelFirstPin> {
  const pin = await resolveDefaultModelFirstPin(db, args.orgId, args.userId);
  if (!pin.selectedModel) {
    throw new Error("A model selection is required");
  }
  return pin;
}
