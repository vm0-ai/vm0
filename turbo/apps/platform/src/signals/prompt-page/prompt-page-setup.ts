import { command } from "ccstate";
import { isSupportedRunModel } from "@vm0/api-contracts/contracts/model-providers";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import { findVideoTemplateItem } from "@vm0/core";
import { sendNewThreadOptimistically$ } from "../chat-page/optimistic-chat-thread-page.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import { defaultAgentId$ } from "../agent.ts";
import { rootSignal$ } from "../root-signal.ts";
import {
  detachedNavigateTo$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { showAppSkeleton$ } from "../app-skeleton.ts";
import {
  onboardGuard$,
  redirectToConfiguredOnboarding$,
} from "../zero-page/onboard-guard.ts";
import { talkDraft$ } from "../zero-page/chat-draft.ts";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  resolveModelFirstUserDefaultSelection,
} from "../zero-page/model-default-selection.ts";

function generationTemplateFromSearchParam(
  template: string | null,
): GenerationTemplateRequest | undefined {
  const id = template?.trim();
  if (!id) {
    return undefined;
  }
  const videoTemplate = findVideoTemplateItem(id);
  if (!videoTemplate) {
    return undefined;
  }
  return {
    type: "video",
    selection: { stylePresetId: videoTemplate.id },
  };
}

/**
 * Lightweight prompt deep-link endpoint.
 *
 * This replaces the use-case-only `/onboarding?prompt=...` path once the
 * workspace/default agent already exists: consume the prompt exactly like the
 * onboarding "Try It" action and route into the new optimistic chat thread.
 */
export const setupPromptPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updateDocumentTitle$, "Prompt");
    set(showAppSkeleton$);

    const params = get(searchParams$);
    const prompt = params.get("prompt")?.trim();
    const requestedModel = params.get("model")?.trim();
    const generationTemplate = generationTemplateFromSearchParam(
      params.get("template"),
    );
    if (!prompt) {
      set(detachedNavigateTo$, "/", { replace: true });
      return;
    }

    if (await set(onboardGuard$, signal)) {
      return;
    }

    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      await set(redirectToConfiguredOnboarding$, params, signal);
      signal.throwIfAborted();
      return;
    }

    const policies = await get(orgModelPolicies$);
    signal.throwIfAborted();
    const userPreference = await get(userModelPreference$);
    signal.throwIfAborted();
    const modelSelection = isSupportedRunModel(requestedModel)
      ? {
          modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
          selectedModel: requestedModel,
        }
      : resolveModelFirstUserDefaultSelection({
          userPreference,
          policies,
        });

    set(get(talkDraft$).clear$);

    const cleaned = new URLSearchParams(params);
    cleaned.delete("prompt");
    cleaned.delete("model");
    cleaned.delete("template");
    cleaned.delete("connector");
    set(updateSearchParams$, cleaned);

    const rootSignal = get(rootSignal$);
    await set(
      sendNewThreadOptimistically$,
      {
        agentId,
        prompt,
        modelSelection,
        generationTemplate,
        computerUseHostId: null,
      },
      rootSignal,
    );
  },
);
