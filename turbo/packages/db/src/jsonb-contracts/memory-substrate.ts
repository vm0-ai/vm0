export interface MemorySourceMetadata {
  readonly workspaceId?: string;
  readonly channelId?: string;
  readonly channelType?: string;
  readonly threadId?: string | null;
  readonly messageId?: string | null;
  readonly messageTs?: string;
  readonly senderId?: string;
  readonly participantIds?: readonly string[];
  readonly fileIds?: readonly string[];
  readonly mailboxEmail?: string;
  readonly historyId?: string;
  readonly direction?: "sent" | "received" | "mixed" | "unknown";
  readonly from?: string | null;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly githubInstallationId?: string;
  readonly githubRemoteInstallationId?: string;
  readonly githubRepository?: string;
  readonly githubSubjectKind?: "issue" | "pull_request";
  readonly githubSubjectNumber?: number;
  readonly githubSubjectUrl?: string;
  readonly githubIssueCommentId?: string;
  readonly githubActorId?: string;
  readonly githubActorLogin?: string;
  readonly githubAuthorId?: string;
  readonly githubAuthorLogin?: string;
  readonly githubLabels?: readonly string[];
  readonly notionWorkspaceId?: string;
  readonly notionWorkspaceName?: string | null;
  readonly notionPageId?: string;
  readonly notionPageUrl?: string | null;
  readonly notionLastEditedTime?: string | null;
  readonly notionEventId?: string;
  readonly notionEventFamily?:
    | "new_child_page"
    | "new_database_item"
    | "page_content_updated";
  readonly notionEventType?:
    | "page.created"
    | "page.content_updated"
    | "page.properties_updated";
  readonly notionScopeType?: "page" | "data_source";
  readonly notionScopeId?: string;
  readonly notionParentTitle?: string | null;
  readonly notionParentUrl?: string | null;
  readonly notionAuthorIds?: readonly string[];
  readonly reason?: string;
}

export interface MemoryContextSpaceMetadata {
  readonly provider?: string;
  readonly externalId?: string;
  readonly displayName?: string;
  readonly reason?: string;
}

export interface MemoryDocumentMetadata {
  readonly provider?: string;
  readonly sourceType?: string;
  readonly externalUrl?: string | null;
  readonly repository?: string;
  readonly subjectKind?: "issue" | "pull_request";
  readonly subjectNumber?: number;
  readonly pageId?: string;
  readonly pageUrl?: string | null;
  readonly workspaceId?: string | null;
  readonly workspaceName?: string | null;
  readonly reason?: string;
}

export interface MemoryDocumentChunkCitation {
  readonly provider: string;
  readonly sourceId: string;
  readonly externalId: string;
  readonly title?: string | null;
  readonly url?: string | null;
  readonly locator?: string | null;
  readonly occurredAt?: string | null;
}

export interface MemoryTombstoneMetadata {
  readonly reason?: string;
  readonly prompt?: string;
  readonly targetId?: string;
  readonly targetTitle?: string | null;
  readonly targetText?: string | null;
  readonly source?: "direct" | "prompt" | "backfill";
}

export interface MemoryVersionMetadata {
  readonly operation?: "create" | "update" | "forget" | "derive";
  readonly reason?: string;
  readonly text?: string;
  readonly kind?: string;
  readonly confidence?: number;
  readonly title?: string | null;
  readonly status?: string;
}
