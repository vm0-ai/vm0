export const ROUTES = {
  home: "/",
  agents: "/agents",
  agentDetail: "/agents/:agentId",
  agentChat: "/agents/:agentId/chat",
  agentIdeas: "/agents/:agentId/ideas",
  agentPermissions: "/agents/:agentId/permissions",
  workflows: "/workflows",
  officialWorkflows: "/workflows/official",
  officialWorkflowDetail: "/workflows/official/:definitionName",
  workflowDetail: "/workflows/:workflowId",
  workflowDetailAutomations: "/workflows/:workflowId/automations",
  workflowDetailInstructions: "/workflows/:workflowId/instructions",
  workflowDetailInfo: "/workflows/:workflowId/info",
  activityInspect: "/activities/inspect",
  activityDetail: "/activities/:activityRunId",
  welcomeThread: "/chats/welcome",
  chat: "/chats/:threadId",
  prompt: "/prompt",
  works: "/works",
  artifacts: "/artifacts",
  sharedThread: "/share/threads/:id",
  browser: "/browsers/:browserThreadId",
  browserAuthorize: "/browser/authorize/:requestToken",
  ideas: "/ideas",
  connectors: "/connectors",
  computerUseAuthorize: "/computer-use/authorize/:requestToken",
  bankingConnectReturn: "/banking/connect/return",
  bankingConnectReturnResult: "/banking/connect/return/:bankingConnectStatus",
  feishuOAuthCallback: "/connectors/feishu/callback",
  connectorCallback: "/connectors/:connectorSlug/callback",
  connectorCallbackResult: "/connectors/:connectorSlug/callback/:status",
  connectorRedirecting: "/connectors/:connectorSlug/redirecting",
  directedConnect: "/connectors/:connectorSlug/connect",
  directedAuthorize: "/connectors/:connectorSlug/authorize",
  settings: "/settings",
  settingsSlack: "/settings/slack",
  settingsTeams: "/settings/teams",
  settingsFeishu: "/settings/feishu",
  settingsStrapi: "/settings/strapi",
  settingsTelegram: "/settings/telegram",
  githubConnect: "/github/connect",
  telegramConnect: "/telegram/connect",
  agentphoneConnect: "/agentphone/connect",
  // Stable public handoff from vm0-marketing into App onboarding.
  onboarding: "/onboarding",
  onboardingWorkflowPicker: "/onboarding/workflow-picker",
  onboardingWorkflowRun: "/onboarding/workflow-run",
  onboardingPresentationTemplate: "/onboarding/presentation-template",
  onboardingPresentationRun: "/onboarding/presentation-run",
  onboardingImageTemplate: "/onboarding/image-template",
  onboardingImageRun: "/onboarding/image-run",
  onboardingVideoTemplate: "/onboarding/video-template",
  onboardingVideoRun: "/onboarding/video-run",
  signIn: "/sign-in",
  signInCatchAll: "/sign-in{/*path}",
  signUp: "/sign-up",
  signUpCatchAll: "/sign-up{/*path}",
  signInV2: "/v2/sign-in",
  signInV2CatchAll: "/v2/sign-in{/*path}",
  signUpV2: "/v2/sign-up",
  signUpV2CatchAll: "/v2/sign-up{/*path}",
  signInToken: "/sign-in-token",
  morningBriefUnsubscribe: "/email/morning-brief/unsubscribe",
  lab: "/_/lab",
  exportData: "/export",
  redeemCampaign: "/redeem/:campaign",
  emailUnsubscribe: "/email/unsubscribe",
  skeleton: "/_/skeleton",
  error: "/_/error",
} as const;

export type RouteKey = keyof typeof ROUTES;
export type RoutePath = (typeof ROUTES)[RouteKey] | `/projects/${string}`;

type WorkflowDetailRouteKey =
  | "workflowDetail"
  | "workflowDetailAutomations"
  | "workflowDetailInstructions"
  | "workflowDetailInfo";

export function isWorkflowDetailRouteKey(
  route: RouteKey | null,
): route is WorkflowDetailRouteKey {
  return (
    route === "workflowDetail" ||
    route === "workflowDetailAutomations" ||
    route === "workflowDetailInstructions" ||
    route === "workflowDetailInfo"
  );
}
