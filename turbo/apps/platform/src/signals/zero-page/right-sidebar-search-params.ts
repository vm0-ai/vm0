export const ARTIFACT_QUERY_PARAM = "artifact";
export const ARTIFACT_INBOX_QUERY_PARAM = "artifacts";
export const ARTIFACT_FULLSCREEN_PARAM = "artifact-fullscreen";
export const PRESENTATION_EDITOR_QUERY_PARAM = "presentation-editor";
export const CHAT_AUTOMATIONS_QUERY_PARAM = "automations";
export const MAIL_DRAFT_QUERY_PARAM = "mail-draft";
export const BROWSER_SESSION_QUERY_PARAM = "browser";

export function clearArtifactSidebarParams(params: URLSearchParams): void {
  params.delete(ARTIFACT_QUERY_PARAM);
  params.delete(ARTIFACT_INBOX_QUERY_PARAM);
  params.delete(ARTIFACT_FULLSCREEN_PARAM);
  // Clear links created by browser bundles before artifact editing was retired.
  params.delete("artifact-html-edit");
  params.delete("artifact-image-edit");
  params.delete(PRESENTATION_EDITOR_QUERY_PARAM);
}

export function clearChatAutomationSidebarParams(
  params: URLSearchParams,
): void {
  params.delete(CHAT_AUTOMATIONS_QUERY_PARAM);
}

export function clearMailDraftSidebarParams(params: URLSearchParams): void {
  params.delete(MAIL_DRAFT_QUERY_PARAM);
}

export function clearBrowserSessionSidebarParams(
  params: URLSearchParams,
): void {
  params.delete(BROWSER_SESSION_QUERY_PARAM);
}
