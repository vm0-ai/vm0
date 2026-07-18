import { command, computed } from "ccstate";
import { chatMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { searchParams$ } from "../route.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";

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

const chatActionCallbackEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.ConnectorActionCallback] ?? false;
});

export const routeChatActionCallback$ = computed((get) => {
  if (!get(chatActionCallbackEnabled$)) {
    return {
      callbackPrompt: null,
      threadId: null,
    } satisfies ChatActionCallback;
  }
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
    if (!get(chatActionCallbackEnabled$)) {
      return;
    }
    const client = get(zeroClient$)(chatMessagesContract);
    await accept(
      client.send({
        body: {
          agentId: args.agentId,
          threadId: args.threadId,
          prompt: args.callbackPrompt,
          hasTextContent: true,
          clientMessageId: crypto.randomUUID(),
          chatThreadSortEventId: crypto.randomUUID(),
        },
        fetchOptions: { signal },
      }),
      [201],
    );
  },
);
