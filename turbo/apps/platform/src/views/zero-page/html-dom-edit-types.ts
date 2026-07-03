export const HTML_DOM_EDIT_PAYLOAD_TYPE = "html_dom_edit" as const;

export interface HtmlDomEditComment {
  readonly id: string;
  readonly targetNodeIds: readonly string[];
  readonly comment: string;
}

export interface HtmlDomEditPayload {
  readonly type: typeof HTML_DOM_EDIT_PAYLOAD_TYPE;
  readonly editRequestId: string;
  readonly htmlSnapshotUrl: string;
  readonly comments: readonly HtmlDomEditComment[];
}

export interface HtmlDomEditDraft {
  readonly comments: readonly HtmlDomEditComment[];
  readonly editRequestId: string;
  readonly html: string;
}
