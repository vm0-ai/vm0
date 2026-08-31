/**
 * Capabilities for the Okou protocol capability system.
 * These protect both /api/okou/* and the compatible /api/zero/* routes.
 */
export const CAPABILITIES = [
  "agent:read",
  "agent:write",
  "agent:delete",
  "agent-run:read",
  "goal:read",
  "goal:agent-result:write",
  "goal:user-control:write",
  "github:read",
  "github:write",
  "slack:write",
  "feishu:write",
  "teams:write",
  "phone:read",
  "phone:write",
  "telegram:read",
  "telegram:write",
  "chat-event:read",
  "chat-event:write",
  "chat-thread:read",
  "chat-thread:write",
  "connector:read",
  "connector:write",
  "billing:read",
  "billing:write",
  "banking:read",
  "maps:read",
  "weather:read",
  "scrape:read",
  "people-search:read",
  "web-search:read",
  "social:read",
  "image-recognition:write",
  "finance:read",
  "seo:read",
  "computer-use:write",
  "browser:read",
  "browser:write",
  "file:read",
  "file:write",
  "host:read",
  "host:write",
  "presentation-template:write",
] as const;

/** Inferred union type of all zero capability strings. */
export type Capability = (typeof CAPABILITIES)[number];

/** Metadata for a single zero capability. */
export interface CapabilityMeta {
  group: string;
  label: string;
}

/**
 * Exhaustive mapping from every zero capability to its UI group and label.
 * Adding a new capability to CAPABILITIES without updating this record
 * will produce a TypeScript compile error.
 */
export const CAPABILITY_META: Record<Capability, CapabilityMeta> = {
  "agent:read": { group: "Agent", label: "Read agents" },
  "agent:write": { group: "Agent", label: "Create & update agents" },
  "agent:delete": { group: "Agent", label: "Delete agents" },
  "agent-run:read": { group: "Agent Runs", label: "View runs & telemetry" },
  "goal:read": { group: "Goals", label: "Read thread goals" },
  "goal:agent-result:write": {
    group: "Goals",
    label: "Complete or block thread goals",
  },
  "goal:user-control:write": {
    group: "Goals",
    label: "Create and manage thread goals",
  },
  "github:read": {
    group: "Integrations",
    label: "Download GitHub files",
  },
  "github:write": {
    group: "Integrations",
    label: "Send GitHub comments and files",
  },
  "slack:write": { group: "Integrations", label: "Send Slack messages" },
  "feishu:write": {
    group: "Integrations",
    label: "Send Feishu messages and files",
  },
  "teams:write": {
    group: "Integrations",
    label: "Send Microsoft Teams messages and files",
  },
  "phone:read": {
    group: "Integrations",
    label: "Download AgentPhone files",
  },
  "phone:write": {
    group: "Integrations",
    label: "Send AgentPhone messages and files",
  },
  "telegram:read": {
    group: "Integrations",
    label: "Download Telegram files",
  },
  "telegram:write": {
    group: "Integrations",
    label: "Send Telegram messages and files",
  },
  "chat-event:read": {
    group: "Integrations",
    label: "Read chat messages",
  },
  "chat-event:write": {
    group: "Integrations",
    label: "Send & cancel chat messages",
  },
  "chat-thread:read": {
    group: "Chat Threads",
    label: "Read chat thread metadata",
  },
  "chat-thread:write": {
    group: "Chat Threads",
    label: "Update chat thread metadata",
  },
  "connector:read": { group: "Connectors", label: "View connected services" },
  "connector:write": {
    group: "Connectors",
    label: "Create and configure custom connectors",
  },
  "billing:read": { group: "Billing", label: "View billing and credits" },
  "billing:write": {
    group: "Billing",
    label: "Buy credits and manage billing",
  },
  "banking:read": {
    group: "Banking",
    label: "Read enabled banking accounts",
  },
  "maps:read": { group: "Maps", label: "Use managed maps services" },
  "weather:read": {
    group: "Weather",
    label: "Use managed weather and air quality services",
  },
  "scrape:read": {
    group: "Scrape",
    label: "Use managed web scraping",
  },
  "people-search:read": {
    group: "People Search",
    label: "Use managed people search",
  },
  "web-search:read": {
    group: "Web Search",
    label: "Use managed web search",
  },
  "social:read": {
    group: "Social",
    label: "Use managed public social data",
  },
  "image-recognition:write": {
    group: "Image Recognition",
    label: "Recognize uploaded images",
  },
  "finance:read": {
    group: "Finance",
    label: "Use managed finance services",
  },
  "seo:read": {
    group: "SEO",
    label: "Use managed SEO services",
  },
  "computer-use:write": {
    group: "Computer Use",
    label: "Control desktop apps",
  },
  "browser:read": {
    group: "Browser",
    label: "View managed browser sessions",
  },
  "browser:write": {
    group: "Browser",
    label: "Create and control managed browser sessions",
  },
  "file:read": { group: "Files", label: "Download uploaded files" },
  "file:write": { group: "Files", label: "Upload files" },
  "host:read": { group: "Hosting", label: "View hosted sites" },
  "host:write": { group: "Hosting", label: "Publish hosted sites" },
  "presentation-template:write": {
    group: "Presentation Templates",
    label: "Publish a presentation template",
  },
};
