import { command } from "ccstate";
import { createElement } from "react";
import { VoiceChatCandidatePage } from "../../views/voice-chat-candidate/voice-chat-candidate-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import {
  endVoiceChatCandidate$,
  vccStatus$,
} from "./voice-chat-candidate-session.ts";

export const setupVoiceChatCandidatePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(VoiceChatCandidatePage), "sidebar");
    set(updateDocumentTitle$, "Voice Chat (Candidate)");

    if (await set(onboardGuard$, signal)) {
      return;
    }

    await set(hideAppSkeleton$, signal);

    signal.addEventListener("abort", () => {
      const status = get(vccStatus$);
      if (status === "connecting" || status === "connected") {
        set(endVoiceChatCandidate$);
      }
    });
  },
);
