import { command } from "ccstate";
import { createElement } from "react";
import { zeroVoiceChatPrepareTriggerContract } from "@vm0/core";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { VoiceChatPage } from "../../views/voice-chat/voice-chat-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { endVoiceChat$, vcStatus$ } from "./voice-chat-session.ts";
import {
  clearPreparation$,
  fetchFreshPreparations$,
  meetingPrepStatus$,
} from "./voice-chat-preparation.ts";
import { zeroClient$ } from "../api-client.ts";
import { defaultAgentId$ } from "../agent.ts";
import { accept } from "../../lib/accept.ts";
import { logger } from "../log.ts";

const L = logger("VoiceChatSetup");

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

    // Pre-warm chat preparation cache (fire-and-forget).
    // By the time the user clicks "Start Voice Chat", the preparation
    // is likely already cached, reducing perceived latency.
    (async () => {
      const agentId = await get(defaultAgentId$);
      if (!agentId || signal.aborted) {
        return;
      }
      const createClient = get(zeroClient$);
      const client = createClient(zeroVoiceChatPrepareTriggerContract);
      await accept(client.trigger({ body: { agentId, mode: "chat" } }), [200], {
        toast: false,
      }).catch(() => {
        return undefined; // Pre-warming is best-effort
      });
    })().catch((error: unknown) => {
      L.warn("Preparation pre-warm failed", error);
    });

    // Fetch fresh meeting preparations list (fire-and-forget)
    set(fetchFreshPreparations$, signal).catch((error: unknown) => {
      L.warn("Fresh preparations list fetch failed", error);
    });

    // End voice chat session and clear preparation when navigating away
    signal.addEventListener("abort", () => {
      const status = get(vcStatus$);
      if (status === "connecting" || status === "connected") {
        set(endVoiceChat$);
      }
      // Only clear preparation if it's not in the "ready" state.
      // "ready" preparations are backed by a 1-hour backend cache
      // and should persist across same-session page navigation.
      const prepStatus = get(meetingPrepStatus$);
      if (prepStatus !== "ready") {
        set(clearPreparation$);
      }
    });
  },
);
