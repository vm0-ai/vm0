export const ROUTES = {
  home: "/",
  agents: "/agents",
  agentDetail: "/agents/:agentId",
  agentChat: "/agents/:agentId/chat",
  agentIdeas: "/agents/:agentId/ideas",
  agentPermissions: "/agents/:agentId/permissions",
  workflows: "/workflows",
  workflowDetail: "/workflows/:workflowId",
  workflowDetailAutomations: "/workflows/:workflowId/automations",
  workflowDetailInstructions: "/workflows/:workflowId/instructions",
  workflowDetailInfo: "/workflows/:workflowId/info",
  activities: "/activities",
  activityInspect: "/activities/inspect",
  activityDetail: "/activities/:activityRunId",
  chat: "/chats/:threadId",
  prompt: "/prompt",
  works: "/works",
  artifacts: "/artifacts",
  browser: "/browsers/:browserId",
  ideas: "/ideas",
  connectors: "/connectors",
  customConnectorProposal: "/connectors/custom/proposal",
  computerUseAuthorize: "/computer-use/authorize/:requestToken",
  feishuOAuthCallback: "/connectors/feishu/callback",
  connectorCallback: "/connectors/:type/callback",
  connectorCallbackResult: "/connectors/:type/callback/:status",
  connectorRedirecting: "/connectors/:type/redirecting",
  directedConnect: "/connectors/:type/connect",
  directedAuthorize: "/connectors/:type/authorize",
  settings: "/settings",
  settingsSlack: "/settings/slack",
  settingsTeams: "/settings/teams",
  settingsFeishu: "/settings/feishu",
  settingsTelegram: "/settings/telegram",
  githubConnect: "/github/connect",
  telegramConnect: "/telegram/connect",
  agentphoneConnect: "/agentphone/connect",
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
  signInToken: "/sign-in-token",
  morningBriefUnsubscribe: "/email/morning-brief/unsubscribe",
  lab: "/_/lab",
  insights: "/insights",
  usage: "/usage",
  exportData: "/export",
  reportError: "/runs/:runId/report-error",
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
