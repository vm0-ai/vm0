import { platformStaticAssetUrl } from "../../lib/static-assets.ts";

function zeroPageAssetUrl(path: string): string {
  return platformStaticAssetUrl(`views/zero-page/${path.replace(/^\/+/u, "")}`);
}

export function avatarSvgAssetUrl(filename: string): string {
  return zeroPageAssetUrl(`assets/avatar-svg/${filename}`);
}

export const emptyActivityImg = zeroPageAssetUrl("assets/empty-activity.webp");
export const emptyArtifactImg = zeroPageAssetUrl("assets/empty-artifact.webp");
export const emptyAutomationImg = zeroPageAssetUrl(
  "assets/empty-automation.webp",
);
export const emptyChatImg = zeroPageAssetUrl("assets/empty-chat.webp");
export const emptyInsightsImg = zeroPageAssetUrl("assets/empty-insights.webp");
export const emptyAutomationsImg = zeroPageAssetUrl(
  "assets/empty-automations-fe7f603eaa3c.webp",
);
export const emptyTemplatesImg = zeroPageAssetUrl(
  "assets/empty-templates-5d941302f8e3.svg",
);
export const emptyWorkflowImg = zeroPageAssetUrl(
  "assets/empty-workflow-96e709d12911.webp",
);
export const computerUseIllustrationImg = zeroPageAssetUrl(
  "assets/computer-use-illustration-eecea534a3ac.png?v=568fa471",
);
export const noConnectorImg = zeroPageAssetUrl("assets/no-connector.webp");
export const noPermissionIllustration = zeroPageAssetUrl(
  "assets/no-permission-illustration.webp",
);
export const planFreeImg = zeroPageAssetUrl(
  "components/org-manage/assets/plan-free.webp",
);
export const planProImg = zeroPageAssetUrl(
  "components/org-manage/assets/plan-pro.webp",
);
export const planTeamImg = zeroPageAssetUrl(
  "components/org-manage/assets/plan-team.webp",
);
