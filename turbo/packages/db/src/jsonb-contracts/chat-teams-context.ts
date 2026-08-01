export interface ChatTeamsFileTokenPayload {
  readonly tenantId: string;
  readonly url: string;
  readonly downloadMode?: "graph";
  readonly id?: string;
  readonly name?: string;
  readonly contentType?: string;
}

/** Teams file descriptor retained as server-private launch material. */
export interface ChatTeamsMessageFile {
  readonly fileId: string;
  readonly sourceId?: string;
  readonly name: string;
  readonly contentType: string;
  readonly payload: ChatTeamsFileTokenPayload;
}

export type ChatTeamsMessageFiles = readonly ChatTeamsMessageFile[];
