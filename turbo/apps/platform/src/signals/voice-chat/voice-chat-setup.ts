import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { VoiceChatPage } from "../../views/voice-chat/voice-chat-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { endVoiceChat$, vcStatus$ } from "./voice-chat-session.ts";
import { clearPreparation$ } from "./voice-chat-preparation.ts";

export const setupVoiceChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(SidebarLayout, null, createElement(VoiceChatPage)),
    );
    set(updateDocumentTitle$, "Voice Chat");

    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(hideAppSkeleton$, signal);

    // End voice chat session and clear preparation when navigating away
    signal.addEventListener("abort", () => {
      const status = get(vcStatus$);
      if (status === "connecting" || status === "connected") {
        set(endVoiceChat$);
      }
      set(clearPreparation$);
    });
  },
);
