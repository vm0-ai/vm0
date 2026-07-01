export const ROUTES = {
  home: "/",
  agents: "/agents",
  memory: "/memory",
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
  automations: "/automations",
  automationDetail: "/automations/:automationId",
  works: "/works",
  ideas: "/ideas",
  connectors: "/connectors",
  customConnectorProposal: "/connectors/custom/proposal",
  computerUseAuthorize: "/computer-use/authorize/:requestToken",
  directedConnect: "/connectors/:type/connect",
  directedAuthorize: "/connectors/:type/authorize",
  settings: "/settings",
  settingsSlack: "/settings/slack",
  settingsTelegram: "/settings/telegram",
  githubConnect: "/github/connect",
  telegramConnect: "/telegram/connect",
  agentphoneConnect: "/agentphone/connect",
  settingsApiKeys: "/settings/api-keys",
  deviceBb0: "/device/bb0",
  onboarding: "/onboarding",
  signIn: "/sign-in",
  signInCatchAll: "/sign-in{/*path}",
  signUp: "/sign-up",
  signUpCatchAll: "/sign-up{/*path}",
  signInToken: "/sign-in-token",
  lab: "/_/lab",
  insights: "/insights",
  usage: "/usage",
  reportError: "/runs/:runId/report-error",
  redeemCampaign: "/redeem/:campaign",
  skeleton: "/_/skeleton",
  error: "/_/error",
} as const;

export type RouteKey = keyof typeof ROUTES;
export type RoutePath = (typeof ROUTES)[RouteKey] | `/projects/${string}`;

export type WorkflowDetailRouteKey =
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
