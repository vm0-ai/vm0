import type { UserMessageDocument } from "@vm0/api-contracts/contracts/chat-threads";

/** attach_files stores legacy file IDs. */
export type ChatEventAttachFiles = string[];

export type ChatEventUserMessage = UserMessageDocument;

export interface ChatEventPresentationGenerationTemplate {
  readonly type: "presentation";
  readonly selection: {
    readonly templateId: string;
    readonly colorSystemId?: string;
    readonly previewUrl?: string;
  };
}

export interface ChatEventVideoGenerationTemplate {
  readonly type: "video";
  readonly selection: {
    readonly stylePresetId: string;
  };
}

export interface ChatEventIllustrationGenerationTemplate {
  readonly type: "illustration";
  readonly selection: {
    readonly illustrationStyleId: string;
  };
}

export interface ChatEventWorkflowGenerationTemplate {
  readonly type: "workflow";
  readonly selection: {
    readonly workflowTemplateId: string;
  };
}

export interface ChatEventWebsiteGenerationTemplate {
  readonly type: "website";
  readonly selection: {
    readonly websiteTemplateId: string;
  };
}

export type ChatEventGenerationTemplate =
  | ChatEventPresentationGenerationTemplate
  | ChatEventVideoGenerationTemplate
  | ChatEventIllustrationGenerationTemplate
  | ChatEventWorkflowGenerationTemplate
  | ChatEventWebsiteGenerationTemplate;

export type ChatEventRecommendedFollowupKind = "talk" | "generate";
export type ChatEventRecommendedFollowupGenerationType =
  | "image"
  | "video"
  | "presentation"
  | "website";

export interface ChatEventRecommendedFollowup {
  readonly prompt: string;
  readonly kind: ChatEventRecommendedFollowupKind;
  readonly generationType?: ChatEventRecommendedFollowupGenerationType;
}

export type ChatEventRecommendedFollowups = ChatEventRecommendedFollowup[];

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

export type ChatEventGoalEvent =
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

export interface ChatEventGoalSnapshot {
  readonly objectiveBrief: string;
}
