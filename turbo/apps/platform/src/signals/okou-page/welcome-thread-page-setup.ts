import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";
import { createElement } from "react";

import { i18n } from "../../i18n/index.ts";
import { WelcomeThreadPage } from "../../views/okou-page/welcome-thread-page.tsx";
import { agents$, defaultAgentId$, homeAgentId$ } from "../agent.ts";
import { setChatAgentId$ } from "../agent-chat.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { assistantName$ } from "../branding.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { ensureAgentDraft$, loadAgentDraft$ } from "./agent-draft.ts";
import { setAgentComposerContext$ } from "./agent-composer-signals.ts";
import { setupAgentChatKeyboardShortcuts$ } from "./agent-chat-keyboard.ts";
import { setTalkDraft$ } from "./chat-draft.ts";
import {
  resetChatPageImageModelSelection$,
  resetChatPageModelSelection$,
  resetChatPageVideoModelSelection$,
} from "./chat-page.ts";
import { onboardGuard$ } from "./onboard-guard.ts";

export const setupWelcomeThreadPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(featureSwitch$)[FeatureSwitchKey.BuiltInWelcomeThread]) {
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }

    if (await set(onboardGuard$, signal)) {
      return;
    }

    const preferredAgentId = await get(homeAgentId$);
    signal.throwIfAborted();
    const agents = await get(agents$);
    signal.throwIfAborted();
    const fallbackAgentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    const agentId = agents.some((agent) => {
      return agent.agentId === preferredAgentId;
    })
      ? preferredAgentId
      : fallbackAgentId;

    if (!agentId) {
      set(detachedNavigateTo$, ROUTES.agents, { replace: true });
      return;
    }

    set(setChatAgentId$, agentId);
    const agentDraft = set(ensureAgentDraft$, agentId);
    set(setAgentComposerContext$, { agentId, agentDraft });
    set(setTalkDraft$, agentDraft.draft);
    set(resetChatPageImageModelSelection$);
    set(resetChatPageModelSelection$);
    set(resetChatPageVideoModelSelection$);
    set(updatePage$, createElement(WelcomeThreadPage), "sidebar");

    await set(hideAppSkeleton$, signal);
    await set(loadAgentDraft$, agentId, agentDraft, signal);
    set(
      updateDocumentTitle$,
      i18n.t(
        ($) => {
          return $.chat.welcomeThread.title;
        },
        { assistantName: get(assistantName$) },
      ),
    );
    set(setupAgentChatKeyboardShortcuts$, signal);
  },
);
