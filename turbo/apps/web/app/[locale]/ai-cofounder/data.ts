import type { CampaignLandingConfig } from "../../components/CampaignLanding";

// Solo-founder paid segment. This is the template config; future paid segments
// are added as sibling routes with their own config of this same shape, reusing
// the CampaignLanding component verbatim.
export const aiCofounderConfig: CampaignLandingConfig = {
  slug: "ai-cofounder",
  utm_campaign: "oo_solofounder_en",
  segment: "solo_founder",
  h1: "Your AI co-founder for the work you can't get to.",
  subhead:
    "Zero connects to your tools and does the work. Research, outreach, triage, reporting. In Slack or on the web.",
  useCases: [
    { prompt: "Research my top 5 competitors and summarize in Slack." },
    {
      prompt: "Draft this week's investor update from Linear and GitHub.",
    },
    { prompt: "Triage my support inbox and draft replies." },
    { prompt: "Find 20 leads and draft outreach." },
  ],
  featuredConnectors: [
    { name: "GitHub", icon: "/assets/connectors/github.svg", dark: true },
    { name: "Linear", icon: "/assets/connectors/linear.svg" },
    { name: "Slack", icon: "/assets/mockup/slack.svg" },
    { name: "Gmail", icon: "/assets/connectors/gmail.svg" },
  ],
  ctaText: "Start your 7-day free trial",
};
