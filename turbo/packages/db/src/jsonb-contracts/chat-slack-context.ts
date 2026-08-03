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

export type ChatSlackMentionDisplayNames = Record<string, string>;
