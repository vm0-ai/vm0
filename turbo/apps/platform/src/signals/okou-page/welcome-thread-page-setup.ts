import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";
import { createElement } from "react";

import { i18n } from "../../i18n/index.ts";
import { WelcomeThreadPage } from "../../views/okou-page/welcome-thread-page.tsx";
import { defaultAgentId$ } from "../agent.ts";
import { setChatAgentId$ } from "../agent-chat.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { assistantName$ } from "../branding.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import {
  featureSwitch$,
  initialFeatureSwitchHydration$,
} from "../external/feature-switch.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { ensureAgentDraft$ } from "./agent-draft.ts";
import { setAgentComposerContext$ } from "./agent-composer-signals.ts";
import { setupAgentChatKeyboardShortcuts$ } from "./agent-chat-keyboard.ts";
import { setTalkDraft$ } from "./chat-draft.ts";
import { createWelcomeThreadContentSignals$ } from "./welcome-thread-content.ts";
import {
  resetChatPageImageModelSelection$,
  resetChatPageModelSelection$,
  resetChatPageVideoModelSelection$,
} from "./chat-page.ts";

export const setupWelcomeThreadPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await get(initialFeatureSwitchHydration$);
    signal.throwIfAborted();
    if (!get(featureSwitch$)[FeatureSwitchKey.OnboardingChat]) {
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }

    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();

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
    const content = set(createWelcomeThreadContentSignals$, signal);
    set(updatePage$, createElement(WelcomeThreadPage, { content }), "sidebar");

    await set(hideAppSkeleton$, signal);
    await set(agentDraft.load$, signal);
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
