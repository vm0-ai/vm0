import type { UserMessageDocument } from "@vm0/api-contracts/contracts/chat-threads";

/** attach_files stores legacy file IDs. */
export type ChatMessageAttachFiles = string[];

export type ChatMessageUserMessage = UserMessageDocument;

export interface ChatMessagePresentationGenerationTemplate {
  readonly type: "presentation";
  readonly selection: {
    readonly templateId: string;
    readonly colorSystemId?: string;
    readonly previewUrl?: string;
  };
}

export interface ChatMessageVideoGenerationTemplate {
  readonly type: "video";
  readonly selection: {
    readonly stylePresetId: string;
  };
}

export interface ChatMessageIllustrationGenerationTemplate {
  readonly type: "illustration";
  readonly selection: {
    readonly illustrationStyleId: string;
  };
}

export interface ChatMessageWorkflowGenerationTemplate {
  readonly type: "workflow";
  readonly selection: {
    readonly workflowTemplateId: string;
  };
}

export interface ChatMessageWebsiteGenerationTemplate {
  readonly type: "website";
  readonly selection: {
    readonly websiteTemplateId: string;
  };
}

export type ChatMessageGenerationTemplate =
  | ChatMessagePresentationGenerationTemplate
  | ChatMessageVideoGenerationTemplate
  | ChatMessageIllustrationGenerationTemplate
  | ChatMessageWorkflowGenerationTemplate
  | ChatMessageWebsiteGenerationTemplate;

export type ChatMessageRecommendedFollowupKind = "talk" | "generate";
export type ChatMessageRecommendedFollowupGenerationType =
  | "image"
  | "video"
  | "presentation"
  | "website";

export interface ChatMessageRecommendedFollowup {
  readonly prompt: string;
  readonly kind: ChatMessageRecommendedFollowupKind;
  readonly generationType?: ChatMessageRecommendedFollowupGenerationType;
}

export type ChatMessageRecommendedFollowups = ChatMessageRecommendedFollowup[];

export interface ChatMessageUsageProviderBreakdown {
  readonly provider: string;
  readonly credits: number;
}

export interface ChatMessageUsageKindBreakdown {
  readonly kind: string;
  readonly credits: number;
  readonly providers: readonly ChatMessageUsageProviderBreakdown[];
}

export interface ChatMessageUsagePayload {
  readonly version: 1;
  readonly totalCredits: number;
  readonly settledAt: string;
  readonly breakdown: readonly ChatMessageUsageKindBreakdown[];
}

export interface ChatMessageAttachFileMetadata {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly objectKey: string;
}

export type ChatMessageAttachFileMetadataList = ChatMessageAttachFileMetadata[];

export type ChatMessageGoalEvent =
  | {
      readonly type: "state";
      readonly status: "active";
      readonly objectiveBrief: string;
    }
  | {
      readonly type: "state";
      readonly status: "paused" | "blocked" | "complete";
    }
  | { readonly type: "cleared" };

export interface ChatMessageGoalSnapshot {
  readonly objectiveBrief: string;
}
