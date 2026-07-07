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
  readonly reason?: string;
}
