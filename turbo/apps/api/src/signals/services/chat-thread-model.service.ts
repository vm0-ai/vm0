import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { and, eq } from "drizzle-orm";

import { badRequestMessage } from "../../lib/error";
import type { Db } from "../external/db";
import {
  publishChatThreadDetailChangedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { nowDate } from "../../lib/time";
import {
  appendChatThreadEvent,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import {
  isCodexFastServiceTierSupported,
  resolveDefaultModelFirstPin,
  type DefaultModelFirstPin,
  resolveModelFirstProviderAdmission,
  resolvePersistedModelFirstRoute,
  type ModelFirstPin,
} from "./model-selection.service";
import type { Tx } from "../../lib/db-types";

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
type ChatThreadModelTransaction = Tx;

interface ResolvePersistedChatThreadModelParams {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly threadSnapshot?: PersistedChatThreadModelSnapshot;
  readonly requestedCodexServiceTier?: CodexServiceTier;
  readonly persistRequestedCodexServiceTier: boolean;
  readonly codexFastModeEnabled: boolean;
}

export function persistedChatThreadModelSnapshotColumns() {
  return {
    selectedModel: chatThreads.selectedModel,
    modelProviderId: chatThreads.modelProviderId,
    modelProviderType: chatThreads.modelProviderType,
    modelProviderCredentialScope: chatThreads.modelProviderCredentialScope,
    codexServiceTier: chatThreads.codexServiceTier,
    agentId: chatThreads.agentId,
  };
}

interface PersistedChatThreadModelSnapshot {
  readonly selectedModel: string | null;
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly agentId: string;
}

export type PersistedChatThreadModelResolutionPath =
  | "read_only"
  | "locked_reconciliation";

export interface ResolvedPersistedChatThreadModel {
  readonly pin: ModelFirstPin;
  readonly providerAdmission: ModelFirstProviderAdmission;
  readonly runCodexServiceTier: "fast" | undefined;
  readonly persistedCodexServiceTier: CodexServiceTier | null;
  readonly selectedModelChanged: boolean;
  readonly resolutionPath: PersistedChatThreadModelResolutionPath;
}

interface PersistedChatThreadModelEvaluation {
  readonly pin: ModelFirstPin;
  readonly providerAdmission: ModelFirstProviderAdmission;
  readonly runCodexServiceTier: "fast" | undefined;
  readonly persistedCodexServiceTier: CodexServiceTier | null;
  readonly selectedModelChanged: boolean;
  readonly tierChanged: boolean;
  readonly requiresReconciliation: boolean;
}

type PersistedChatThreadModelEvaluationResult =
  | {
      readonly kind: "resolved";
      readonly evaluation: PersistedChatThreadModelEvaluation;
    }
  | {
      readonly kind: "error";
      readonly error: ReturnType<typeof badRequestMessage>;
    };

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
  params: Pick<
    ResolvePersistedChatThreadModelParams,
    "orgId" | "threadId" | "userId"
  >,
): Promise<PersistedChatThreadModelSnapshot | undefined> {
  const [thread] = await tx
    .select(persistedChatThreadModelSnapshotColumns())
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, params.threadId),
        eq(chatThreads.userId, params.userId),
        chatThreadOrganizationCondition(tx, params.orgId),
      ),
    )
    .limit(1)
    .for("update");
  return thread?.agentId ? { ...thread, agentId: thread.agentId } : undefined;
}

async function loadChatThreadModel(
  db: Db,
  params: Pick<
    ResolvePersistedChatThreadModelParams,
    "orgId" | "threadId" | "userId"
  >,
): Promise<PersistedChatThreadModelSnapshot | undefined> {
  const [thread] = await db
    .select(persistedChatThreadModelSnapshotColumns())
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, params.threadId),
        eq(chatThreads.userId, params.userId),
        chatThreadOrganizationCondition(db, params.orgId),
      ),
    )
    .limit(1);
  return thread?.agentId ? { ...thread, agentId: thread.agentId } : undefined;
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

function legacyProviderPinPresent(
  thread: PersistedChatThreadModelSnapshot,
): boolean {
  return (
    thread.modelProviderId !== null ||
    thread.modelProviderType !== null ||
    thread.modelProviderCredentialScope !== null
  );
}

async function persistReconciledChatThreadModel(args: {
  readonly tx: ChatThreadModelTransaction;
  readonly params: ResolvePersistedChatThreadModelParams;
  readonly thread: PersistedChatThreadModelSnapshot;
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
  const pinColumns = chatThreadModelPinColumns(args.pin);
  await args.tx
    .update(chatThreads)
    .set({
      modelProviderId: pinColumns.modelProviderId,
      modelProviderType: pinColumns.modelProviderType,
      modelProviderCredentialScope: pinColumns.modelProviderCredentialScope,
      selectedModel: pinColumns.selectedModel,
      codexServiceTier: args.persistedCodexServiceTier,
      updatedAt,
    })
    .where(
      and(
        eq(chatThreads.id, args.params.threadId),
        eq(chatThreads.userId, args.params.userId),
        chatThreadOrganizationCondition(args.tx, args.params.orgId),
      ),
    );
  if (args.selectedModelChanged) {
    await appendChatThreadEvent(args.tx, {
      kind: "model_selection_updated",
      userId: args.params.userId,
      orgId: args.params.orgId,
      chatThreadId: args.params.threadId,
      agentId: args.thread.agentId,
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
      agentId: args.thread.agentId,
      serviceTier: chatThreadServiceTierFromCodex(
        args.persistedCodexServiceTier,
      ),
      createdAt: updatedAt,
    });
  }
}

async function evaluatePersistedChatThreadModel(
  db: Db,
  params: ResolvePersistedChatThreadModelParams,
  thread: PersistedChatThreadModelSnapshot,
): Promise<PersistedChatThreadModelEvaluationResult> {
  let pin: ModelFirstPin;
  let selectedModelChanged: boolean;
  if (thread.selectedModel === null) {
    const defaultPin = await resolveDefaultModelFirstPin(
      db,
      params.orgId,
      params.userId,
    );
    if (!defaultPin.selectedModel) {
      return {
        kind: "error",
        error: badRequestMessage(
          "No valid model route is configured for this workspace",
        ),
      };
    }
    pin = {
      modelProviderId: defaultPin.modelProviderId,
      modelProviderType: defaultPin.modelProviderType,
      modelProviderCredentialScope: defaultPin.modelProviderCredentialScope,
      selectedModel: defaultPin.selectedModel,
    };
    selectedModelChanged = true;
  } else {
    const modelResolution = await resolvePersistedModelFirstRoute({
      db,
      orgId: params.orgId,
      userId: params.userId,
      selectedModel: thread.selectedModel,
    });
    if (!modelResolution.route) {
      return {
        kind: "error",
        error: badRequestMessage(
          "No valid model route is configured for this workspace",
        ),
      };
    }
    pin = {
      modelProviderId: modelResolution.route.modelProviderId,
      modelProviderType: modelResolution.route.modelProviderType,
      modelProviderCredentialScope:
        modelResolution.route.modelProviderCredentialScope,
      selectedModel: modelResolution.route.selectedModel,
    };
    selectedModelChanged =
      modelResolution.selectedModelChanged ||
      thread.selectedModel !== pin.selectedModel;
  }
  const providerAdmission = await resolveModelFirstProviderAdmission({
    db,
    orgId: params.orgId,
    userId: params.userId,
    modelPin: pin,
    requestedModelProvider: undefined,
  });
  const tier = resolveCodexTier({
    persistedTier: thread.codexServiceTier,
    requestedTier: params.requestedCodexServiceTier,
    persistRequestedTier: params.persistRequestedCodexServiceTier,
    fastSupported: isCodexFastServiceTierSupported({
      selectedModel: pin.selectedModel,
      codexFastModeEnabled: params.codexFastModeEnabled,
    }),
    selectedModelChanged,
  });
  if (tier.kind === "error") {
    return { kind: "error", error: tier.error };
  }

  return {
    kind: "resolved",
    evaluation: {
      pin,
      providerAdmission,
      runCodexServiceTier: tier.runCodexServiceTier,
      persistedCodexServiceTier: tier.persistedCodexServiceTier,
      selectedModelChanged,
      tierChanged: tier.tierChanged,
      requiresReconciliation:
        selectedModelChanged ||
        tier.tierChanged ||
        legacyProviderPinPresent(thread),
    },
  };
}

function resolvedPersistedChatThreadModel(
  evaluation: PersistedChatThreadModelEvaluation,
  resolutionPath: PersistedChatThreadModelResolutionPath,
): ResolvedPersistedChatThreadModel {
  return {
    pin: evaluation.pin,
    providerAdmission: evaluation.providerAdmission,
    runCodexServiceTier: evaluation.runCodexServiceTier,
    persistedCodexServiceTier: evaluation.persistedCodexServiceTier,
    selectedModelChanged: evaluation.selectedModelChanged,
    resolutionPath,
  };
}

async function resolvePersistedChatThreadModelInTransaction(
  tx: ChatThreadModelTransaction,
  params: ResolvePersistedChatThreadModelParams,
): Promise<PersistedChatThreadModelTransactionResult> {
  const thread = await loadLockedChatThreadModel(tx, params);
  if (!thread) {
    return transactionResultWithoutPublish(null);
  }

  const evaluated = await evaluatePersistedChatThreadModel(tx, params, thread);
  if (evaluated.kind === "error") {
    return transactionResultWithoutPublish(evaluated.error);
  }
  const { evaluation } = evaluated;

  await persistReconciledChatThreadModel({
    tx,
    params,
    thread,
    pin: evaluation.pin,
    persistedCodexServiceTier: evaluation.persistedCodexServiceTier,
    selectedModelChanged: evaluation.selectedModelChanged,
    tierChanged: evaluation.tierChanged,
  });
  return {
    resolved: resolvedPersistedChatThreadModel(
      evaluation,
      "locked_reconciliation",
    ),
    publishThreadList:
      evaluation.selectedModelChanged || evaluation.tierChanged,
    publishThreadDetail: evaluation.tierChanged,
  };
}

export async function resolvePersistedChatThreadModel(
  params: ResolvePersistedChatThreadModelParams,
): Promise<
  ResolvedPersistedChatThreadModel | ReturnType<typeof badRequestMessage> | null
> {
  const thread =
    params.threadSnapshot ?? (await loadChatThreadModel(params.db, params));
  if (!thread) {
    return null;
  }
  const evaluated = await evaluatePersistedChatThreadModel(
    params.db,
    params,
    thread,
  );
  if (evaluated.kind === "error") {
    return evaluated.error;
  }
  // An optimistic snapshot is authoritative only when this send writes
  // nothing back to the thread.
  if (!evaluated.evaluation.requiresReconciliation) {
    return resolvedPersistedChatThreadModel(evaluated.evaluation, "read_only");
  }

  // Discard every optimistic decision before a possible write so a concurrent
  // explicit model or tier update cannot be restored from the stale snapshot.
  const result = await params.db.transaction((tx) => {
    return resolvePersistedChatThreadModelInTransaction(tx, params);
  });

  await Promise.all([
    result.publishThreadList
      ? publishThreadListChangedSafely({
          userId: params.userId,
          orgId: params.orgId,
        })
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
): Promise<DefaultModelFirstPin> {
  const pin = await resolveDefaultModelFirstPin(db, args.orgId, args.userId);
  if (!pin.selectedModel) {
    throw new Error("A model selection is required");
  }
  return pin;
}
