export const ARTIFACT_QUERY_PARAM = "artifact";
export const ARTIFACT_INBOX_QUERY_PARAM = "artifacts";
export const ARTIFACT_FULLSCREEN_PARAM = "artifact-fullscreen";
export const PRESENTATION_EDITOR_QUERY_PARAM = "presentation-editor";
export const CHAT_AUTOMATIONS_QUERY_PARAM = "automations";

export function clearArtifactSidebarParams(params: URLSearchParams): void {
  params.delete(ARTIFACT_QUERY_PARAM);
  params.delete(ARTIFACT_INBOX_QUERY_PARAM);
  params.delete(ARTIFACT_FULLSCREEN_PARAM);
  params.delete(PRESENTATION_EDITOR_QUERY_PARAM);
}

export function clearChatAutomationSidebarParams(
  params: URLSearchParams,
): void {
  params.delete(CHAT_AUTOMATIONS_QUERY_PARAM);
}
