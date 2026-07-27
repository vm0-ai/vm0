import type { ChatThreadEvent } from "@vm0/api-contracts/contracts/chat-threads";

type WithoutSeqId<T> = T extends unknown
  ? Omit<T, "seqId"> & { readonly seqId?: never }
  : never;

export type OptimisticChatThreadEvent = WithoutSeqId<ChatThreadEvent>;

export type ChatThreadEventView = ChatThreadEvent | OptimisticChatThreadEvent;
