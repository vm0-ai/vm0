import { platformStaticAssetUrl } from "../../lib/static-assets.ts";

function zeroPageAssetUrl(path: string): string {
  return platformStaticAssetUrl(`views/zero-page/${path.replace(/^\/+/u, "")}`);
}

export function avatarSvgAssetUrl(filename: string): string {
  return zeroPageAssetUrl(`assets/avatar-svg/${filename}`);
}

/** The looping clip in the Slack start card's "how it works" dialog. */
export const slackHowItWorksVideo = zeroPageAssetUrl(
  "assets/slack-how-it-works-1f407cd378ba.mp4",
);
export const emptyArtifactImg = zeroPageAssetUrl("assets/empty-artifact.webp");
export const emptyChatImg = zeroPageAssetUrl("assets/empty-chat.webp");
export const emptyAutomationsImg = zeroPageAssetUrl(
  "assets/empty-automations-fe7f603eaa3c.webp",
);
export const emptyWorkflowImg = zeroPageAssetUrl(
  "assets/empty-workflow-96e709d12911.webp",
);
export const emptyUsageImg = zeroPageAssetUrl(
  "assets/empty-usage-a1f6d48793ba.webp",
);
export const emptySearchImg = zeroPageAssetUrl(
  "assets/empty-search-b4e60a8e07b8.webp",
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
