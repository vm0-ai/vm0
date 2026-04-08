import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { VoiceChatPage } from "../../views/voice-chat/voice-chat-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

export const setupVoiceChatPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(SidebarLayout, null, createElement(VoiceChatPage)),
    );
    set(updateDocumentTitle$, "Voice Chat");

    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(hideAppSkeleton$, signal);
  },
);
