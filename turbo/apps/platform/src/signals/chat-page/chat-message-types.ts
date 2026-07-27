import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";

type WithoutSeqId<T> = T extends unknown
  ? Omit<T, "seqId"> & { readonly seqId?: never }
  : never;

export type OptimisticChatMessage = WithoutSeqId<PagedChatMessage>;

export type ChatMessage = PagedChatMessage | OptimisticChatMessage;
