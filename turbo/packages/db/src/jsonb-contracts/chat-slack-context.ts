/** Raw Slack file descriptor retained as server-private claim material. */
export interface ChatSlackMessageFile {
  readonly id?: string;
  readonly name?: string;
  readonly title?: string;
  readonly mimetype?: string;
  readonly filetype?: string;
  readonly pretty_type?: string;
  readonly size?: number;
  readonly original_w?: string;
  readonly original_h?: string;
  readonly thumb_360?: string;
  readonly thumb_480?: string;
  readonly permalink?: string;
  readonly permalink_public?: string;
  readonly url_private_download?: string;
}

export type ChatSlackMessageFiles = readonly ChatSlackMessageFile[];

/**
 * Canonical input asset materialized for one raw Slack file of the message.
 * Snapshotted with the launch context so prompt rendering never has to resolve
 * the asset again. `slackFileId` is the upstream Slack file ID this asset was
 * imported from, which pairs it back to its entry in `message_files`.
 */
export interface ChatSlackMessageAsset {
  readonly assetId: string;
  readonly slackFileId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly status: "pending" | "ready" | "failed";
}

export type ChatSlackMessageAssets = readonly ChatSlackMessageAsset[];

export type ChatSlackMentionDisplayNames = Record<string, string>;
