export interface RelationshipSyncJobPayload {
  readonly connectorId?: string;
  readonly relationshipStateId?: string;
  readonly memorySource?: {
    readonly provider: "gmail" | "slack";
    readonly externalId: string;
  };
  readonly gmailThreadId?: string;
  readonly gmailMessageIds?: readonly string[];
  readonly gmailMessage?: {
    readonly historyId: string;
    readonly messageId: string;
    readonly threadId: string | null;
    readonly mailboxEmail?: string;
    readonly occurredAt?: string | null;
    readonly direction?: "received" | "sent" | null;
    readonly from?: string | null;
    readonly to?: readonly string[];
    readonly cc?: readonly string[];
    readonly subject?: string | null;
  };
  readonly historyId?: string;
  readonly reason?: string;
}

export interface RelationshipInteractionMetadata {
  readonly direction?: "sent" | "received" | "mixed" | "unknown";
  readonly participants?: readonly string[];
  readonly labels?: readonly string[];
}
