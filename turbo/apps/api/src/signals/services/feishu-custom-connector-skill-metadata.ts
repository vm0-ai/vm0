export const FEISHU_CUSTOM_CONNECTOR_SKILL_METADATA = {
  name: "feishu",
  description:
    "Feishu OpenAPI for user-authorized messaging, people search, cloud documents, calendars, and tasks. Use when the user asks to work with Feishu.",
} as const;

export function getFeishuCustomConnectorSlug(installationId: string): string {
  return `_feishu-${installationId}`;
}
