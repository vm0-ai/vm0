import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { AgentChatPage } from "../../views/zero-page/agent-chat-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  searchParams$,
  updateSearchParams$,
  detachedNavigateTo$,
} from "../route.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import {
  currentAgentId$,
  defaultAgentId$,
  agents$,
  rememberLastUsedAgentId$,
} from "../agent.ts";
import { setChatAgentId$ } from "../agent-chat.ts";
import { createDraftSignals, setTalkDraft$, talkDraft$ } from "./chat-draft.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import {
  reloadTagline$,
  resetChatPageModelSelection$,
} from "./zero-chat-page.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import {
  ensureAgentDraft$,
  loadAgentDraft$,
  type EnsuredAgentDraft,
} from "./agent-draft.ts";
import { reloadUserModelPreference$ } from "../external/user-model-preference.ts";
import { openQueueDrawer$ } from "../queue-page/queue-drawer-state.ts";
import { checkUnifiedSettingsParam$ } from "./settings/settings-dialog.ts";
import { subscribeComputerUseHostsChanged$ } from "./computer-use-hosts.ts";

export const setupAgentChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(AgentChatPage), "sidebar");
    set(updateDocumentTitle$, "Chat");
    set(reloadTagline$);

    set(resetChatPageModelSelection$);
    set(reloadUserModelPreference$);

    const features = get(featureSwitch$);
    const agentDraftsEnabled =
      features[FeatureSwitchKey.AgentChatDrafts] ?? false;
    const localDraft = agentDraftsEnabled ? undefined : createDraftSignals();
    if (localDraft) {
      set(setTalkDraft$, localDraft);
    }

    // Read agent ID from URL immediately (synchronous) and update sidebar
    // highlight early so the UI responds without waiting for async data.
    const agentId = get(currentAgentId$);
    let agentDraft: EnsuredAgentDraft | undefined;
    if (agentId) {
      set(setChatAgentId$, agentId);
      if (agentDraftsEnabled) {
        agentDraft = set(ensureAgentDraft$, agentId);
        set(setTalkDraft$, agentDraft.draft);
      }
    }

    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    if (!agentId) {
      throw new Error("Chat page requires an active agent, but none found");
    }

    const agents = await get(agents$);
    signal.throwIfAborted();
    const agent = agents.find((candidate) => {
      return candidate.id === agentId;
    });
    if (!agent) {
      const defaultAgentId = await get(defaultAgentId$);
      signal.throwIfAborted();
      if (!defaultAgentId || defaultAgentId === agentId) {
        throw new Error("Chat page requires an active agent, but none found");
      }

      set(detachedNavigateTo$, "/agents/:agentId/chat", {
        pathParams: { agentId: defaultAgentId },
        searchParams: get(searchParams$),
        replace: true,
      });
      return;
    }

    set(rememberLastUsedAgentId$, agentId);
    set(updateDocumentTitle$, agent.displayName ?? "Chat");

    await set(checkUnifiedSettingsParam$, signal);

    const params = get(searchParams$);
    const prompt = params.get("prompt");
    const queue = params.get("queue");
    if (agentDraftsEnabled && agentDraft && !prompt) {
      await set(
        loadAgentDraft$,
        agentId,
        agentDraft.draft,
        agentDraft.isNew,
        signal,
      );
    }
    if (prompt) {
      const targetDraft = agentDraft?.draft ?? localDraft ?? get(talkDraft$);
      set(targetDraft.clear$);
      set(targetDraft.setInput$, prompt);
      const next = new URLSearchParams(params);
      next.delete("prompt");
      set(updateSearchParams$, next);
    }
    if (queue === "1") {
      set(openQueueDrawer$, signal);
    }

    await set(subscribeComputerUseHostsChanged$, signal);
  },
);
