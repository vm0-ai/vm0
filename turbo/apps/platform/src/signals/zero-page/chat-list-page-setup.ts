import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { ZeroChatListPage } from "../../views/zero-page/zero-chat-list-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { setChatAgentId$ } from "../agent-chat.ts";
import { chatThreads$ } from "../chat-page/chat-message.ts";
import { homeAgentId$ } from "../agent.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";

export const setupChatListPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const agentId = params.get("agentId");

    set(updatePage$, createElement(ZeroChatListPage), "sidebar");
    set(updateDocumentTitle$, "Chats");

    await set(hideAppSkeleton$, signal);

    if (await set(onboardGuard$, signal)) {
      return;
    }

    if (agentId) {
      set(setChatAgentId$, agentId);
    }

    // First-run redirect: a brand-new mobile user has no threads yet, so
    // the chat list is an empty box. Bounce them to the default agent's
    // chat page (which renders the composer + greeting). Once they have
    // ≥ 1 thread, future visits stay on /chats.
    const features = await get(featureSwitch$);
    signal.throwIfAborted();
    const mobileNativeEnabled =
      features[FeatureSwitchKey.MobileNativeV1] ?? false;
    if (!mobileNativeEnabled) {
      return;
    }
    const threads = await get(chatThreads$);
    signal.throwIfAborted();
    if (threads.length > 0) {
      return;
    }
    const defaultAgentId = await get(homeAgentId$);
    signal.throwIfAborted();
    if (defaultAgentId) {
      set(detachedNavigateTo$, "/agents/:agentId/chat", {
        pathParams: { agentId: defaultAgentId },
        replace: true,
      });
    }
  },
);
