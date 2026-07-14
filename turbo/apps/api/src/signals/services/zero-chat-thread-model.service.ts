import type { CodexServiceTier } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { and, eq, sql } from "drizzle-orm";

import { badRequestMessage } from "../../lib/error";
import type { Db } from "../external/db";
import {
  publishChatThreadDetailChangedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { nowDate } from "../external/time";
import { appendChatThreadEvent } from "./zero-chat-thread-event.service";
import {
  isCodexFastServiceTierSupported,
  resolveDefaultModelFirstPin,
  resolveModelFirstProviderAdmission,
  resolvePersistedModelFirstPin,
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

export interface ResolvedPersistedChatThreadModel {
  readonly pin: ModelFirstPin;
  readonly providerAdmission: ModelFirstProviderAdmission;
  readonly runCodexServiceTier: "fast" | undefined;
  readonly persistedCodexServiceTier: CodexServiceTier | null;
}

export async function resolvePersistedChatThreadModel(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly fallbackSelectedModel?: string | null;
  readonly requestedCodexServiceTier?: CodexServiceTier;
  readonly persistRequestedCodexServiceTier: boolean;
  readonly codexFastModeEnabled: boolean;
}): Promise<
  ResolvedPersistedChatThreadModel | ReturnType<typeof badRequestMessage> | null
> {
  for (;;) {
    const [thread] = await params.db
      .select({
        selectedModel: chatThreads.selectedModel,
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
      .limit(1);
    if (!thread) {
      return null;
    }

    const storedSelectedModel =
      thread.selectedModel ?? params.fallbackSelectedModel ?? null;
    const modelResolution = await resolvePersistedModelFirstPin({
      db: params.db,
      orgId: params.orgId,
      userId: params.userId,
      selectedModel: storedSelectedModel,
    });
    if (!modelResolution.pin.selectedModel) {
      return badRequestMessage("A model selection is required");
    }

    const providerAdmission = await resolveModelFirstProviderAdmission({
      db: params.db,
      orgId: params.orgId,
      userId: params.userId,
      modelPin: modelResolution.pin,
      requestedModelProvider: undefined,
    });
    const fastSupported = isCodexFastServiceTierSupported({
      selectedModel: modelResolution.pin.selectedModel,
      effectiveModelProvider: providerAdmission.effectiveModelProvider,
      codexFastModeEnabled: params.codexFastModeEnabled,
    });
    const compatibleStoredTier =
      thread.codexServiceTier === "fast" && fastSupported ? "fast" : null;
    const runCodexServiceTier = params.persistRequestedCodexServiceTier
      ? params.requestedCodexServiceTier === "fast" && fastSupported
        ? "fast"
        : undefined
      : (compatibleStoredTier ?? undefined);
    const persistedCodexServiceTier = params.persistRequestedCodexServiceTier
      ? (runCodexServiceTier ?? null)
      : compatibleStoredTier;
    const selectedModelChanged =
      modelResolution.selectedModelChanged ||
      storedSelectedModel !== thread.selectedModel;
    const tierChanged = persistedCodexServiceTier !== thread.codexServiceTier;

    if (!selectedModelChanged && !tierChanged) {
      return {
        pin: modelResolution.pin,
        providerAdmission,
        runCodexServiceTier,
        persistedCodexServiceTier,
      };
    }

    const updatedAt = nowDate();
    const updated = await params.db.transaction(async (tx) => {
      const [updatedThread] = await tx
        .update(chatThreads)
        .set({
          modelProviderId: null,
          modelProviderType: null,
          modelProviderCredentialScope: null,
          selectedModel: modelResolution.pin.selectedModel,
          codexServiceTier: persistedCodexServiceTier,
          updatedAt,
        })
        .where(
          and(
            eq(chatThreads.id, params.threadId),
            eq(chatThreads.userId, params.userId),
            sql`${chatThreads.selectedModel} IS NOT DISTINCT FROM ${thread.selectedModel}`,
            sql`${chatThreads.codexServiceTier} IS NOT DISTINCT FROM ${thread.codexServiceTier}`,
          ),
        )
        .returning({ id: chatThreads.id });
      if (!updatedThread) {
        return false;
      }
      if (selectedModelChanged) {
        await appendChatThreadEvent(tx, {
          kind: "model_selection_updated",
          userId: params.userId,
          orgId: params.orgId,
          chatThreadId: updatedThread.id,
          agentComposeId: thread.agentComposeId,
          selectedModel: modelResolution.pin.selectedModel,
          createdAt: updatedAt,
        });
      }
      return true;
    });
    if (!updated) {
      continue;
    }

    await Promise.all([
      publishThreadListChangedSafely(params.userId),
      publishChatThreadDetailChangedSafely(params.userId, params.threadId),
    ]);
    return {
      pin: modelResolution.pin,
      providerAdmission,
      runCodexServiceTier,
      persistedCodexServiceTier,
    };
  }
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
