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
export const illBotanicalSrc = zeroPageAssetUrl("assets/ill-botanical.webp");
export const illEndpaperSrc = zeroPageAssetUrl("assets/ill-endpaper.webp");
export const illFlatfolkSrc = zeroPageAssetUrl("assets/ill-flatfolk.webp");
export const illFolkSrc = zeroPageAssetUrl("assets/ill-folk.webp");
export const illInkdabSrc = zeroPageAssetUrl("assets/ill-inkdab.webp");
export const illIsoSceneSrc = zeroPageAssetUrl("assets/ill-iso-scene.webp");
export const illMellowPopSrc = zeroPageAssetUrl("assets/ill-mellow-pop.webp");
export const illOpedcoverSrc = zeroPageAssetUrl("assets/ill-opedcover.webp");
export const illPapernookSrc = zeroPageAssetUrl("assets/ill-papernook.webp");
export const illPosterSrc = zeroPageAssetUrl("assets/ill-poster.webp");
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
export const trialWorkflowSrc = zeroPageAssetUrl(
  "assets/trial-workflow.webp",
);
export const webCafeSrc = zeroPageAssetUrl("assets/web-cafe.webp");
export const webEnergeticSrc = zeroPageAssetUrl("assets/web-energetic.webp");
export const webFantasySrc = zeroPageAssetUrl("assets/web-fantasy.webp");
export const webModernSrc = zeroPageAssetUrl("assets/web-modern.webp");
export const zeroAnimatedSrc = zeroPageAssetUrl("assets/zero-animated.webp");
