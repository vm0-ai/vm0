import type { UserMessageDocument } from "@vm0/api-contracts/contracts/chat-threads";

export type ChatEventUserMessage = UserMessageDocument;

export interface ChatEventUsageProviderBreakdown {
  readonly provider: string;
  readonly credits: number;
}

export interface ChatEventUsageKindBreakdown {
  readonly kind: string;
  readonly credits: number;
  readonly providers: readonly ChatEventUsageProviderBreakdown[];
}

export interface ChatEventUsagePayload {
  readonly version: 1;
  readonly totalCredits: number;
  readonly settledAt: string;
  readonly breakdown: readonly ChatEventUsageKindBreakdown[];
}

export interface ChatEventAttachFileMetadata {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly objectKey: string;
}

export type ChatEventAttachFileMetadataList = ChatEventAttachFileMetadata[];
