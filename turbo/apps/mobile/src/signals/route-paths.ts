/**
 * Route path constants for the mobile app.
 *
 * Mirrors platform's route-paths.ts pattern. React Navigation handles
 * actual path matching — these constants serve as the single source of truth
 * for route names across signals and views.
 */

export const ROUTES = {
  home: "Home",
  chat: "Chat",
  chatList: "ChatList",
  agents: "Agents",
  agentDetail: "AgentDetail",
  agentChat: "AgentChat",
  settings: "Settings",
  onboarding: "Onboarding",
  connectors: "Connectors",
  lab: "Lab",
} as const;

export type RouteKey = (typeof ROUTES)[keyof typeof ROUTES];
export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];
