import type { ChatEvent } from "@vm0/api-contracts/contracts/chat-threads";

type WithoutSeqId<T> = T extends unknown
  ? Omit<T, "seqId"> & { readonly seqId?: never }
  : never;

export type OptimisticChatMessage = WithoutSeqId<ChatEvent>;

export type ChatMessage = ChatEvent | OptimisticChatMessage;

export type ChatInputMessage = Extract<
  ChatMessage,
  { eventType: "input.prompt" | "input.rejected" }
>;
