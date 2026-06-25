export const HTML_DOM_EDIT_PAYLOAD_TYPE = "html_dom_edit" as const;

export interface HtmlDomEditComment {
  readonly id: string;
  readonly targetNodeIds: readonly string[];
  readonly comment: string;
  readonly selectedText?: string;
}

export interface HtmlDomEditPayload {
  readonly type: typeof HTML_DOM_EDIT_PAYLOAD_TYPE;
  readonly originalUrl: string;
  readonly workingCopyUrl: string;
  readonly comments: readonly HtmlDomEditComment[];
}
