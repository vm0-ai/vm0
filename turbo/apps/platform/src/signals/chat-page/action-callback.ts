import { command, computed } from "ccstate";
import { chatMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { searchParams$ } from "../route.ts";
import { textToMessageDocument } from "../zero-page/user-message-document-codec.ts";

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
    const client = get(zeroClient$)(chatMessagesContract);
    const features = get(featureSwitch$);
    const structuredPromptEnabled =
      features[FeatureSwitchKey.StructuredPrompt] ?? false;
    const structuredPrompt = structuredPromptEnabled
      ? textToMessageDocument(args.callbackPrompt)
      : undefined;
    if (structuredPromptEnabled && !structuredPrompt) {
      throw new Error("Failed to serialize structured callback prompt");
    }
    await accept(
      client.send({
        body: {
          agentId: args.agentId,
          threadId: args.threadId,
          prompt: args.callbackPrompt,
          hasTextContent: true,
          ...(structuredPrompt ? { structuredPrompt } : {}),
          clientMessageId: crypto.randomUUID(),
          chatThreadSortEventId: crypto.randomUUID(),
        },
        fetchOptions: { signal },
      }),
      [201],
    );
  },
);
