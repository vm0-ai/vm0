import type { ChatThreadEvent } from "@okouai/api-contracts/contracts/chat-threads";

type WithoutSeqId<T> = T extends unknown
  ? Omit<T, "seqId"> & { readonly seqId?: never }
  : never;

export type UnsequencedChatThreadEvent = WithoutSeqId<ChatThreadEvent>;

export type OptimisticChatThreadEvent = UnsequencedChatThreadEvent;

export type CompatibleChatThreadEvent =
  | ChatThreadEvent
  | UnsequencedChatThreadEvent;

export type ChatThreadEventView = CompatibleChatThreadEvent;
