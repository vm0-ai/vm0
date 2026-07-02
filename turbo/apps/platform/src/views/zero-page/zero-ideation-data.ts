import type { ConnectorType } from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

interface UseCase {
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly connectors?: readonly ConnectorType[];
  readonly featureFlag?: FeatureSwitchKey;
}

interface Category {
  readonly id: string;
  readonly title: string;
  readonly cases: readonly UseCase[];
}

const categories: readonly Category[] = [
  {
    id: "engineer",
    title: "Engineer",
    cases: [
      {
        title: "Auto-merge GitHub PRs",
        description: "Reviews the diff, waits for CI, and merges when green",
        prompt:
          "Set up a workflow that reviews pull requests labeled ready-to-merge, waits for CI checks to pass, merges them, and posts the result to Slack",
        connectors: ["github", "vercel", "slack"],
      },
      {
        title: "File Sentry crashes as GitHub issues",
        description: "Ranks new errors by user impact and files the bad ones",
        prompt:
          "Every hour, check Sentry for new errors, rank them by user impact, open a GitHub issue for the worst ones, and notify the owner in Slack",
        connectors: ["sentry", "github", "linear", "slack"],
      },
      {
        title: "Watch Sentry after a release",
        description:
          "Compares the new release crash-free rate against baseline",
        prompt:
          "After each release, monitor the new version's crash-free rate in Sentry against baseline and alert Slack with a rollback suggestion if it regresses",
        connectors: ["sentry", "github", "vercel", "slack"],
      },
      {
        title: "Post GitHub updates to Slack",
        description: "Compiles your logged work into a daily progress update",
        prompt:
          "Every weekday at 9am, compile my merged and in-progress work from GitHub and Linear into a progress update and post it to Slack",
        connectors: ["github", "linear", "sentry", "slack"],
      },
      {
        title: "Draft GitHub release notes in Notion",
        description: "Turns merged PRs since the last tag into clean notes",
        prompt:
          "When a pull request is labeled shipped, turn the merged PRs since the last release into clean release notes saved in Notion",
        connectors: ["github", "notion", "slack"],
      },
      {
        title: "Report AI model costs to Slack",
        description: "Token spend and p95 latency per model and route",
        prompt:
          "Every day, report LLM token spend and p95 latency per model and route from Langfuse to Slack",
        connectors: ["langfuse", "slack"],
      },
    ],
  },
  {
    id: "product",
    title: "Product",
    cases: [
      {
        title: "Turn a GitHub idea into a Notion spec",
        description: "Expands a labeled idea into a structured PRD",
        prompt:
          "When a GitHub issue is labeled needs-spec, expand it into a structured PRD with problem, users, requirements, and acceptance criteria in Notion",
        connectors: ["github", "notion", "figma"],
      },
      {
        title: "Summarize user feedback in Notion",
        description: "Clusters feedback into themes and ranks by frequency",
        prompt:
          "Every week, gather user feedback from Productlane, Typeform, Intercom, and GitHub, cluster it into themes, and write a ranked summary in Notion",
        connectors: ["productlane", "typeform", "intercom", "github", "notion"],
      },
      {
        title: "Post release notes to Slack",
        description: "Drafts the user-facing changelog and posts it",
        prompt:
          "When a pull request is labeled release, draft a user-facing changelog and post it to Slack and Notion",
        connectors: ["github", "notion", "slack"],
      },
      {
        title: "Sync the Linear roadmap to Notion",
        description: "Keeps a Now/Next/Later board in sync with tickets",
        prompt:
          "Every day, sync Linear ticket status into a Now/Next/Later roadmap board in Notion",
        connectors: ["linear", "notion"],
      },
      {
        title: "Track feature usage with PostHog",
        description: "Flags features rising or falling this week",
        prompt:
          "Every week, check PostHog for features rising or falling in usage and post the shifts to Slack",
        connectors: ["posthog", "slack"],
      },
      {
        title: "Flag Figma designs without a task",
        description: "Finds design frames missing a linked build task",
        prompt:
          "Every day, check Figma for design frames that don't have a linked build task and flag them in Slack",
        connectors: ["figma", "linear", "slack"],
      },
    ],
  },
  {
    id: "data",
    title: "Data",
    cases: [
      {
        title: "Post daily metrics to Slack",
        description: "Visitors, signups, and activation every morning",
        prompt:
          "Every morning, pull visitors, signups, and activation from Plausible, PostHog, and Clerk and post the KPIs to Slack",
        connectors: ["plausible", "posthog", "clerk", "slack"],
      },
      {
        title: "Run a daily query into Google Sheets",
        description: "Runs a saved query and writes formatted results",
        prompt:
          "Every day, run my saved database query and write the formatted results into a Google Sheet",
        connectors: ["maskdb", "google-sheets", "slack"],
      },
      {
        title: "Check the PostHog signup funnel",
        description: "Runs the funnel and flags the biggest drop-off",
        prompt:
          "Every week, run the signup funnel in PostHog and post the biggest drop-off to Slack",
        connectors: ["posthog", "slack"],
      },
      {
        title: "Alert when a metric moves",
        description: "Watches a key metric and alerts when it deviates",
        prompt:
          "Every hour, watch a key metric and alert Slack when it deviates from its normal range",
        connectors: ["plausible", "posthog", "slack"],
      },
      {
        title: "Track signup sources in Google Sheets",
        description: "Ties signups to channel and campaign in a sheet",
        prompt:
          "Every day, attribute new signups to their channel and campaign and append them to a tracking Google Sheet",
        connectors: ["clerk", "plausible", "google-sheets"],
      },
      {
        title: "Build the weekly deck in Gamma",
        description: "Assembles the metrics deck you'd build by hand",
        prompt:
          "Every week, assemble a metrics deck in Gamma from Google Sheets and analytics and post it to Slack",
        connectors: ["google-sheets", "plausible", "gamma", "slack"],
      },
    ],
  },
  {
    id: "marketing",
    title: "Marketing",
    cases: [
      {
        title: "Track keyword ranks with Ahrefs",
        description: "Tracks target keywords and reports movers",
        prompt:
          "Every week, track target keyword rankings in Ahrefs and Search Console and report the movers in Notion",
        connectors: ["ahrefs", "google-search-console", "notion"],
      },
      {
        title: "Publish scheduled posts to Buffer",
        description: "Publishes whatever's scheduled for today",
        prompt:
          "Every day, publish the content scheduled for today from the Notion calendar to Strapi and queue the social posts in Buffer",
        connectors: ["notion", "strapi", "buffer"],
      },
      {
        title: "Turn blog posts into X posts",
        description: "Turns each new post into social variants",
        prompt:
          "Every day, turn newly published blog posts into social variants and queue them to X through Buffer",
        connectors: ["strapi", "buffer", "x"],
      },
      {
        title: "Draft the newsletter in Mailchimp",
        description: "Assembles the issue from what shipped",
        prompt:
          "Every month, assemble a newsletter from shipped features and stage a draft in Mailchimp",
        connectors: ["github", "mailchimp"],
      },
      {
        title: "Compare Google Ads vs last month",
        description: "Spend, CPA, and ROAS vs the prior period",
        prompt:
          "Every day, compare Google Ads and Meta Ads spend, CPA, and ROAS against the prior period and flag anomalies in Slack",
        connectors: ["google-ads", "meta-ads", "slack"],
      },
      {
        title: "Watch Reddit and HN for brand mentions",
        description: "Pings you when someone mentions your product",
        prompt:
          "Every hour, search the web, Hacker News, Reddit, and X for mentions of our product and post them to Slack",
        connectors: ["exa", "x", "slack"],
      },
    ],
  },
  {
    id: "sales",
    title: "Sales",
    cases: [
      {
        title: "Catch leads from Gmail",
        description: "Spots buying signals and logs the lead",
        prompt:
          "Scan new Gmail messages for buying signals, log qualified leads to a Google Sheet, enrich them with Apollo, and suggest the next step in Slack",
        connectors: ["gmail", "apollo", "google-sheets", "slack"],
      },
      {
        title: "Add new Gmail contacts to HubSpot",
        description: "Email from someone new adds and enriches them",
        prompt:
          "When an email arrives from someone who isn't in the CRM yet, add and enrich them in HubSpot using Apollo",
        connectors: ["gmail", "hubspot", "apollo"],
      },
      {
        title: "Research new signups with Apollo",
        description: "Posts each new signup's background to the channel",
        prompt:
          "Every hour, check Clerk for new signups, research their background and company with Apollo, and post a snapshot to Slack",
        connectors: ["clerk", "apollo", "slack"],
      },
      {
        title: "Send Gmail follow-ups automatically",
        description: "Advances sequences and drafts the next touch",
        prompt:
          "Every day, advance outreach sequences and draft the next follow-up for anyone who hasn't replied",
        connectors: ["instantly", "apollo", "gmail"],
      },
      {
        title: "Prep for Google Calendar meetings",
        description: "A one-page dossier before each meeting",
        prompt:
          "When a meeting with an external attendee is added to my calendar, research them with Apollo and Gong and send me a prep brief in Slack",
        connectors: ["google-calendar", "apollo", "gong", "slack"],
      },
      {
        title: "Log Gong calls to HubSpot",
        description: "Logs call notes and next steps to the deal",
        prompt:
          "After a sales call, pull the Gong transcript and log the notes and next steps to the HubSpot deal",
        connectors: ["gong", "hubspot", "slack"],
      },
    ],
  },
  {
    id: "support",
    title: "Support",
    cases: [
      {
        title: "Sort and route Zendesk tickets",
        description: "Sets urgency, routes it, drafts the first reply",
        prompt:
          "When a support ticket arrives, set its severity, route it to the right team, and draft a first reply",
        connectors: ["zendesk", "linear"],
      },
      {
        title: "Draft replies from your Notion FAQ",
        description: "Checks the FAQ in Notion, then drafts the reply",
        prompt:
          "When a support question arrives, check the FAQ in Notion and draft an on-brand reply for review",
        connectors: ["intercom", "notion", "gmail"],
      },
      {
        title: "Send bugs to GitHub and Slack",
        description: "Packages repro and impact for engineering",
        prompt:
          "When an issue is labeled bug, package the reproduction steps and impact and send it to the engineering channel in Slack",
        connectors: ["github", "linear", "slack"],
      },
      {
        title: "Turn fixes into Notion help docs",
        description: "Turns a resolved ticket into a reusable article",
        prompt:
          "When a ticket is marked resolved, turn the fix into a reusable help article in Notion",
        connectors: ["notion", "zendesk"],
      },
      {
        title: "Spot churn risk in Stripe and Zendesk",
        description: "Flags churn risk and drafts a recovery email",
        prompt:
          "Every day, flag accounts with billing issues or a spike in tickets and draft a recovery email",
        connectors: ["clerk", "stripe", "zendesk", "resend", "slack"],
      },
      {
        title: "Summarize Zendesk tickets daily",
        description: "Summarizes the last 24 hours by severity and age",
        prompt:
          "Every morning, summarize the last 24 hours of Zendesk tickets by severity and age and post it to Slack",
        connectors: ["zendesk", "slack"],
      },
    ],
  },
  {
    id: "ceo",
    title: "CEO",
    cases: [
      {
        title: "Post a daily company brief to Slack",
        description: "Wins, risks, and what needs attention",
        prompt:
          "Every morning at 9am, compile product health, growth, revenue, and engineering into a company brief and post it to Slack",
        connectors: [
          "plausible",
          "clerk",
          "stripe",
          "github",
          "sentry",
          "slack",
        ],
      },
      {
        title: "Post daily industry news to Slack",
        description: "What happened in your space in the last 24h",
        prompt:
          "Every day, gather AI and competitor news from the last 24 hours and post a brief to Slack",
        connectors: ["exa", "slack"],
      },
      {
        title: "Build the business review in Gamma",
        description: "MRR, burn, runway, and growth as a deck",
        prompt:
          "Every week, build a business review deck in Gamma covering MRR, burn, runway, and growth",
        connectors: ["stripe", "clerk", "gamma"],
      },
      {
        title: "Highlight key emails in Gmail",
        description: "Just the few emails that actually need you",
        prompt:
          "Every morning, surface the few emails in Gmail that actually need my attention and post them to Slack",
        connectors: ["gmail", "slack"],
      },
      {
        title: "Draft the investor update in Google Docs",
        description: "KPIs and highlights into an editable update",
        prompt:
          "Every month, assemble KPIs and highlights into an editable investor update in Google Docs",
        connectors: ["stripe", "google-sheets", "google-docs"],
      },
      {
        title: "Get Gmail reconnect reminders",
        description: "People you've gone quiet with, plus an opener",
        prompt:
          "Every week, surface important contacts I haven't talked to lately and suggest an opener",
        connectors: ["gmail", "google-calendar", "slack"],
      },
    ],
  },
  {
    id: "operations",
    title: "Operations",
    cases: [
      {
        title: "Sync Asana projects to Notion",
        description: "Rolls every team's task status into one board",
        prompt:
          "Every day, roll up task status from Asana into a single status board in Notion and post a digest",
        connectors: ["asana", "notion"],
      },
      {
        title: "Turn meeting notes into Asana tasks",
        description: "Extracts action items into assigned tasks",
        prompt:
          "After a meeting, extract the action items from the transcript and create assigned tasks in Asana",
        connectors: ["fireflies", "asana"],
      },
      {
        title: "File Gmail invoices to Google Drive",
        description: "Saves the file to Drive and logs the expense",
        prompt:
          "When an invoice is labeled in Gmail, save the file to the right Google Drive folder and log the expense in a sheet",
        connectors: ["gmail", "google-drive", "google-sheets"],
      },
      {
        title: "Onboard new hires in Asana",
        description: "Fires the checklist and provisions docs",
        prompt:
          "When a new hire is added, fire the onboarding checklist in Asana and provision their docs in Google Drive",
        connectors: ["deel", "asana", "google-drive"],
      },
      {
        title: "Chase overdue Asana tasks",
        description: "Finds what's late and nudges the owner",
        prompt:
          "Every day, find overdue tasks in Asana and nudge their owners in Slack",
        connectors: ["asana", "slack"],
      },
      {
        title: "Catch Google Calendar conflicts",
        description: "Catches double-bookings before they land",
        prompt:
          "When a calendar event is created, detect double-bookings and conflicts and alert me in Slack",
        connectors: ["cal-com", "google-calendar", "slack"],
      },
    ],
  },
  {
    id: "everyone",
    title: "Everyone",
    cases: [
      {
        title: "Sort Gmail and draft replies",
        description: "Sorts mail by urgency, drafts replies you approve",
        prompt:
          "Sort new Gmail messages by urgency and draft replies for me to approve",
        connectors: ["gmail"],
      },
      {
        title: "Get a morning brief in Slack",
        description: "Your schedule and the emails that need you",
        prompt:
          "Every morning, send me a brief with my schedule and the emails that need me and post it to Slack",
        connectors: ["gmail", "google-calendar", "slack"],
      },
      {
        title: "Research your calendar meetings",
        description: "A dossier on the person and company before a call",
        prompt:
          "When a meeting is added to my calendar, research the attendees and company and send me a dossier before the call",
        connectors: ["google-calendar", "exa", "slack"],
      },
      {
        title: "Summarize Gmail newsletters",
        description: "One tidy weekly summary of what you subscribe to",
        prompt:
          "Every week, summarize the newsletters labeled in Gmail into one digest and post it to Slack",
        connectors: ["gmail", "slack"],
      },
      {
        title: "Get meeting recaps in Slack",
        description: "Decisions and action items after the call",
        prompt:
          "After a meeting, send me a recap with the decisions and action items",
        connectors: ["fireflies", "gmail", "slack"],
      },
      {
        title: "Turn flagged Gmail into Todoist tasks",
        description: "Researches the flagged email, files a ready task",
        prompt:
          "When I flag an email in Gmail, research the topic and file a ready-to-do task in Todoist",
        connectors: ["gmail", "todoist"],
      },
    ],
  },
];

function isEnabled(
  useCase: UseCase,
  features?: Partial<Record<FeatureSwitchKey, boolean>>,
): boolean {
  if (!useCase.featureFlag) {
    return true;
  }
  return !!features?.[useCase.featureFlag];
}

export function getCategories(
  features?: Partial<Record<FeatureSwitchKey, boolean>>,
): readonly Category[] {
  return categories
    .map((c) => {
      return {
        ...c,
        cases: c.cases.filter((u) => {
          return isEnabled(u, features);
        }),
      };
    })
    .filter((c) => {
      return c.cases.length > 0;
    });
}

export function getRandomPrompts(
  count: number,
  features?: Partial<Record<FeatureSwitchKey, boolean>>,
): UseCase[] {
  const all = categories.flatMap((c) => {
    return c.cases.filter((u) => {
      return u.connectors && u.connectors.length > 0 && isEnabled(u, features);
    });
  });
  const shuffled = [...all].sort(() => {
    return Math.random() - 0.5;
  });
  return shuffled.slice(0, count);
}
