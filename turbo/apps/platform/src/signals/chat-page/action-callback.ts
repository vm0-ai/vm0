import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { zeroClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { searchParams$ } from "../route.ts";
import { textToMessageDocument } from "../zero-page/user-message-document-codec.ts";
import { sendChatEventWithCompatibility } from "./chat-event-api-rollout.ts";

export interface ChatActionCallback {
  readonly callbackPrompt: string | null;
  readonly threadId: string | null;
}

export function chatActionCallbackFromUrl(url: URL): ChatActionCallback {
  return {
    callbackPrompt: url.searchParams.get("callbackPrompt"),
    threadId: url.searchParams.get("threadId"),
  };
}

export const routeChatActionCallback$ = computed((get) => {
  const params = get(searchParams$);
  return {
    callbackPrompt: params.get("callbackPrompt"),
    threadId: params.get("threadId"),
  } satisfies ChatActionCallback;
});

export const runChatActionCallback$ = command(
  async (
    { get },
    args: {
      readonly threadId: string;
      readonly agentId: string;
      readonly callbackPrompt: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const features = get(featureSwitch$);
    const structuredPromptEnabled =
      features[FeatureSwitchKey.StructuredPrompt] ?? false;
    const structuredPrompt = structuredPromptEnabled
      ? textToMessageDocument(args.callbackPrompt)
      : undefined;
    if (structuredPromptEnabled && !structuredPrompt) {
      throw new Error("Failed to serialize structured callback prompt");
    }
    await sendChatEventWithCompatibility(
      get(zeroClient$),
      {
        agentId: args.agentId,
        threadId: args.threadId,
        prompt: args.callbackPrompt,
        hasTextContent: true,
        ...(structuredPrompt ? { structuredPrompt } : {}),
        clientEventId: crypto.randomUUID(),
        chatThreadSortEventId: crypto.randomUUID(),
      },
      signal,
    );
  },
);
