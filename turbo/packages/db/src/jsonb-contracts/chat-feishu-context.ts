/** Feishu file descriptor retained as server-private delivery material. */
export interface ChatFeishuMessageFile {
  readonly fileId: string;
  readonly messageId: string;
  readonly fileKey: string;
  readonly type: "file" | "image";
}

export type ChatFeishuMessageFiles = readonly ChatFeishuMessageFile[];
