import type { CampaignLandingConfig } from "../../components/CampaignLanding";

// Office / operations paid segment. Follows the ai-cofounder template: a pure
// config object consumed verbatim by the shared CampaignLanding component, so
// the only thing that changes per segment is the copy and connector lineup.
export const aiOpsAssistantConfig: CampaignLandingConfig = {
  slug: "ai-ops-assistant",
  utm_campaign: "oo_officeops_en",
  segment: "office_ops",
  h1: "Your AI assistant for the busywork you never get to.",
  subhead:
    "Zero connects to your tools and does the work. Data entry, follow-ups, scheduling, reporting. In Slack or on the web.",
  useCases: [
    { prompt: "Pull this week's numbers into a Google Sheet and summarize." },
    { prompt: "Draft follow-up emails to everyone I met this week." },
    { prompt: "Tidy my meeting notes into a shareable Notion doc." },
    { prompt: "Schedule the team sync and send the agenda." },
  ],
  featuredConnectors: [
    { name: "Google Sheets", icon: "/assets/connectors/google-sheet.svg" },
    { name: "Gmail", icon: "/assets/connectors/gmail.svg" },
    { name: "Notion", icon: "/assets/connectors/notion.svg", dark: true },
    { name: "Slack", icon: "/assets/mockup/slack.svg" },
  ],
  ctaText: "Start your 7-day free trial",
};
