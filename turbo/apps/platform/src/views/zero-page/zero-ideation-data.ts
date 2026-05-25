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
    id: "reports",
    title: "Reports",
    cases: [
      {
        title: "Daily standup report",
        description: "Morning metrics become a slide deck posted to Slack",
        prompt:
          "Set up a daily standup report that pulls data from GitHub, Sentry, Axiom, and Plausible every morning, generates a pptx, and posts it to #all-vm0",
        connectors: ["github", "sentry", "axiom", "plausible", "slack"],
      },
      {
        title: "Personal weekly digest",
        description: "Pull requests, email, and calendar in one Slack update",
        prompt:
          "Create a personal weekly report workflow that merges GitHub PRs, Gmail, and Calendar data into a summary and sends it to Slack",
        connectors: ["github", "gmail", "google-calendar", "slack"],
      },
      {
        title: "GitHub progress weekly",
        description: "Weekly repo activity summarized by feature",
        prompt:
          "Generate a weekly GitHub progress report summarized by feature modules",
        connectors: ["github"],
      },
      {
        title: "Morning brief",
        description:
          "Email, calendar, and notes turned into a short daily plan",
        prompt:
          "Set up a morning brief that pulls updates from Gmail, Calendar, and Notion every morning and posts a daily plan to Slack",
        connectors: ["gmail", "google-calendar", "notion", "slack"],
      },
      {
        title: "GitHub PR summarizer",
        description:
          "Merged pull request summaries in Notion with optional Slack posts",
        prompt:
          "Summarize all merged GitHub PRs from the past week and save a daily report in Notion with an optional Slack post",
        connectors: ["github", "notion", "slack"],
      },
      {
        title: "Sentry issue digest",
        description: "Morning digest of issues grouped by severity",
        prompt:
          "Set up a daily Sentry issue digest that summarizes critical and high severity issues every morning and posts to Slack",
        connectors: ["sentry", "slack"],
      },
      {
        title: "Vercel deploy digest",
        description:
          "It links each deployment to its commit and alerts Slack when a deploy fails",
        prompt:
          "Set up a Vercel deploy digest that monitors deployments, links each to its GitHub commit, and sends Slack alerts on failures",
        connectors: ["vercel", "github", "slack"],
      },
      {
        title: "Cloudflare traffic & security report",
        description: "Weekly Slack recap of traffic and security events",
        prompt:
          "Set up a weekly Cloudflare report that summarizes traffic analytics, WAF events, and bot activity, then posts to Slack",
        connectors: ["cloudflare", "slack"],
      },
      {
        title: "Metabase dashboard digest",
        description: "Dashboard snapshots posted to Slack on a schedule",
        prompt:
          "Set up a weekly Metabase digest that snapshots key dashboards, captures charts, and posts them to Slack every Monday morning",
        connectors: ["metabase", "slack"],
      },
      {
        title: "RevenueCat subscription digest",
        description:
          "Subscription metrics in Sheets with churn alerts in Slack",
        prompt:
          "Set up a daily RevenueCat digest that tracks new subscriptions, renewals, and cancellations in Google Sheets and alerts on Slack for churn spikes",
        connectors: ["revenuecat", "google-sheets", "slack"],
      },
      {
        title: "Xero financial summary",
        description: "Weekly profit and cash flow from Xero in Slack",
        prompt:
          "Set up a weekly Xero financial summary that pulls profit & loss and cash flow data and posts a formatted report to Slack",
        connectors: ["xero", "slack"],
      },
      {
        title: "Strava team fitness digest",
        description: "Weekly team activity summary posted to Slack",
        prompt:
          "Set up a weekly Strava digest that summarizes team members' running and cycling activities and posts a leaderboard to Slack",
        connectors: ["strava", "slack"],
      },
      {
        title: "Streak pipeline report",
        description: "Weekly CRM pipeline stats from Gmail in Slack",
        prompt:
          "Set up a weekly Streak pipeline report that summarizes deal stages, win rates, and upcoming follow-ups, then posts to Slack",
        connectors: ["streak", "slack"],
      },
    ],
  },
  {
    id: "github",
    title: "GitHub",
    cases: [
      {
        title: "Batch-create issues",
        description: "Paste a list and Zero opens the issues for you",
        prompt:
          "Create the following GitHub issues and assign them to the right people: 1) ... 2) ... 3) ...",
        connectors: ["github"],
      },
      {
        title: "Codebase investigation",
        description: "Give a URL and Zero traces the bug through the repo",
        prompt:
          "Look at this page and search the codebase to find the root cause of the bug: [paste URL]",
        connectors: ["github"],
      },
      {
        title: "Deep-research code analysis",
        description: "Explains how a subsystem works in your codebase",
        prompt:
          "Do a deep research on how the agent run queue locking mechanism works in our codebase",
        connectors: ["github"],
      },
      {
        title: "Security & dependency alert digest",
        description: "Weekly security and dependency alerts from GitHub",
        prompt:
          "Generate a weekly GitHub security and dependency alert digest and post it to Slack",
        connectors: ["github", "slack"],
      },
      {
        title: "Jira \u2194 GitHub issue sync",
        description: "Keeps Jira tickets and GitHub issues in sync",
        prompt:
          "Set up a bidirectional sync between Jira and GitHub so that issue status, labels, and comments stay in sync across both platforms",
        connectors: ["jira", "github", "slack"],
      },
      {
        title: "GitLab to GitHub migration helper",
        description: "Mirrors GitLab issues and merge requests into GitHub",
        prompt:
          "Set up a workflow that mirrors GitLab issues to GitHub issues and notifies on Slack when new items are synced",
        connectors: ["gitlab", "github", "slack"],
      },
    ],
  },
  {
    id: "collaboration",
    title: "Collaboration",
    cases: [
      {
        title: "Email assistant",
        description: "Morning inbox summary with suggested next steps",
        prompt:
          "Set up a daily email assistant that summarizes my inbox every morning and suggests actions for each thread",
        connectors: ["gmail"],
      },
      {
        title: "Calendar optimizer",
        description: "Helps with conflicts, overload, and focus time",
        prompt:
          "Analyze my calendar for today and recommend how to manage conflicts, prevent overload, and schedule focus time",
        connectors: ["google-calendar"],
      },
      {
        title: "Send messages on your behalf",
        description: "Posts team announcements to Slack for you",
        prompt:
          "Send a message to the team on my behalf: I'll be taking a day off tomorrow. Please reach out to [name] for urgent matters.",
        connectors: ["slack"],
      },
      {
        title: "Browser screenshots",
        description: "Opens a page in the browser and returns a screenshot",
        prompt:
          "Open this URL in the browser and take a screenshot: [paste URL]",
      },
      {
        title: "Self-update instructions",
        description: "Update the agent instructions right in chat",
        prompt: "Update yourself: add the following instructions \u2014 ...",
      },
      {
        title: "Support ticket router",
        description: "Tickets go to Notion and urgent ones ping Slack",
        prompt:
          "Set up a support ticket router that monitors Gmail for support emails, classifies them by category and priority, creates Notion entries, and sends Slack alerts for critical tickets",
        connectors: ["gmail", "notion", "slack"],
      },
      {
        title: "Meeting notes pipeline",
        description: "Fireflies notes to Notion with follow ups in Slack",
        prompt:
          "Set up a meeting notes pipeline that takes Fireflies transcripts, generates a summary in Notion, and posts action items to Slack after each meeting",
        connectors: ["fireflies", "notion", "slack"],
      },
      {
        title: "Calendly booking sync",
        description: "New bookings on your calendar with a Slack ping",
        prompt:
          "Set up a Calendly sync that adds new bookings to Google Calendar and sends a Slack notification with meeting details",
        connectors: ["calendly", "google-calendar", "slack"],
      },
      {
        title: "Todoist \u2192 Notion task sync",
        description: "Todoist tasks mirrored in Notion for the team",
        prompt:
          "Set up a sync that mirrors my Todoist tasks into a Notion database so the team can see what I'm working on",
        connectors: ["todoist", "notion"],
      },
      {
        title: "Lark \u2194 Slack message relay",
        description: "Forwards messages between Lark and Slack both ways",
        prompt:
          "Set up a message relay between a Lark group and a Slack channel so that messages are forwarded both ways",
        connectors: ["lark", "slack"],
        featureFlag: FeatureSwitchKey.LarkConnector,
      },
      {
        title: "Google Drive file organizer",
        description: "New files sorted into folders automatically",
        prompt:
          "Set up a workflow that watches Google Drive for new files, classifies them by content, and moves them into the right folders",
        connectors: ["google-drive"],
      },
      {
        title: "tl;dv meeting recap",
        description:
          "Meeting recordings summarized in Notion with action items",
        prompt:
          "Set up a workflow that takes tl;dv meeting recordings, generates a summary with action items in Notion, and posts highlights to Slack",
        connectors: ["tldv", "notion", "slack"],
      },
      {
        title: "Granola notes to Notion",
        description: "Granola meeting notes synced to a Notion database",
        prompt:
          "Set up a sync that takes meeting notes from Granola and organizes them in a Notion database grouped by project",
        connectors: ["granola", "notion"],
      },
      {
        title: "LINE message relay",
        description: "Forward LINE messages to Slack and vice versa",
        prompt:
          "Set up a message relay between a LINE group and a Slack channel so messages flow both ways",
        connectors: ["line", "slack"],
      },
      {
        title: "Loops email campaign",
        description: "Draft and send transactional emails via Loops",
        prompt:
          "Set up a workflow that drafts email campaigns from Notion content and sends them through Loops",
        connectors: ["loops", "notion"],
      },
      {
        title: "Brevo email nurture sequence",
        description: "Automated email sequences from CRM events",
        prompt:
          "Set up a Brevo nurture sequence that sends onboarding emails when new contacts are added to a Notion database",
        connectors: ["brevo", "notion", "slack"],
      },
    ],
  },
  {
    id: "content",
    title: "Growth",
    cases: [
      {
        title: "Content planner",
        description: "Brainstorm topics and outline an editorial calendar",
        prompt:
          "Help me brainstorm content ideas and plan an editorial calendar for the next month in Notion",
        connectors: ["notion"],
      },
      {
        title: "Marketing content planning",
        description:
          "Plans launch stories from Slack, interviews, and competitors",
        prompt:
          "Help me plan GTM use case content. Reference our team's Slack usage patterns, user interviews, and competitor analysis",
        connectors: ["slack"],
      },
      {
        title: "Onboarding email use cases",
        description: "Finds onboarding angles from Slack and interviews",
        prompt:
          "Analyze our Slack usage records and user interviews to extract key onboarding use cases for email campaigns",
        connectors: ["slack"],
      },
      {
        title: "Product copy & naming",
        description: "Friendlier names for technical terms in the product",
        prompt:
          'Suggest user-friendly alternative names for "logs" in our product UI',
      },
      {
        title: "Competitor research to Notion",
        description: "Research on X saved as structured notes in Notion",
        prompt:
          "Research competitor [name] on X/Twitter and save the findings into our Notion research database",
        connectors: ["x", "notion"],
      },
      {
        title: "Pricing analysis",
        description:
          "Analyze competitor pricing strategies and compare with similar products",
        prompt:
          "Analyze the pricing strategy of Claude Code and compare it with similar products",
      },
      {
        title: "Social media content calendar",
        description: "Turns a Sheets calendar into posts for each network",
        prompt:
          "Generate social media content for Twitter and LinkedIn from my Google Sheets content calendar and schedule the posts",
        connectors: ["google-sheets", "x"],
      },
      {
        title: "YouTube to X thread repurposer",
        description:
          "When a new YouTube video is published, generate a Notion summary and an X thread to promote it",
        prompt:
          "Set up a workflow that monitors my YouTube channel for new videos, creates a summary page in Notion, and generates a promotional X thread",
        connectors: ["youtube", "notion", "x"],
      },
      {
        title: "Competitive intel scraper",
        description:
          "Firecrawl watches competitor sites and logs changes in Notion",
        prompt:
          "Set up a weekly competitor scraper using Firecrawl that monitors competitor websites for pricing and feature changes, saves findings to Notion, and alerts on Slack",
        connectors: ["firecrawl", "notion", "slack"],
      },
      {
        title: "Dev.to auto-publisher",
        description: "Publishes Notion posts to Dev.to and links them on X",
        prompt:
          "Set up a workflow that publishes Notion pages tagged as 'ready' to Dev.to and posts a link on X",
        connectors: ["devto", "notion", "x"],
      },
      {
        title: "Instagram engagement tracker",
        description: "Engagement in Sheets with weekly Slack summaries",
        prompt:
          "Set up an Instagram tracker that logs post engagement metrics to Google Sheets and posts a weekly summary to Slack",
        connectors: ["instagram", "google-sheets", "slack"],
      },
      {
        title: "SimilarWeb traffic comparison",
        description: "Traffic benchmarks versus competitors saved in Notion",
        prompt:
          "Run a monthly SimilarWeb traffic comparison between our site and top 5 competitors, save the report to Notion",
        connectors: ["similarweb", "notion"],
      },
      {
        title: "ElevenLabs audio content",
        description: "Voice narration from Notion articles saved to Drive",
        prompt:
          "Set up a workflow that takes blog posts from Notion, generates voice narration with ElevenLabs, and saves the audio to Google Drive",
        connectors: ["elevenlabs", "notion", "google-drive"],
      },
      {
        title: "HeyGen video from script",
        description: "Notion script becomes a HeyGen video with a team ping",
        prompt:
          "Set up a workflow that takes a script from Notion, generates a video with HeyGen, and sends a Slack notification when it's ready",
        connectors: ["heygen", "notion", "slack"],
      },
      {
        title: "Lead follow-up pipeline",
        description: "New leads become HubSpot tasks with Slack alerts",
        prompt:
          "Set up a lead follow-up pipeline that monitors Gmail for new leads, analyzes them with AI, creates HubSpot tasks, and notifies the sales team on Slack",
        connectors: ["gmail", "hubspot", "slack"],
      },
      {
        title: "Win/loss reporter",
        description: "Win and loss trends from the pipeline in Slack",
        prompt:
          "Set up a weekly win/loss report that analyzes our HubSpot pipeline, tracks deal outcomes, and posts trends to Slack",
        connectors: ["hubspot", "slack"],
      },
      {
        title: "Intercom conversation triager",
        description: "Intercom chats become prioritized Notion tasks",
        prompt:
          "Set up a workflow that takes Intercom conversations, classifies them, and creates structured tasks in Notion",
        connectors: ["intercom", "notion"],
      },
      {
        title: "Salesforce pipeline digest",
        description: "Weekly Salesforce opportunity updates in Slack",
        prompt:
          "Set up a weekly Salesforce pipeline digest that summarizes new opportunities, stage changes, and close dates, then posts to Slack",
        connectors: ["salesforce", "slack"],
      },
      {
        title: "Zendesk \u2192 Notion knowledge base",
        description:
          "Extract frequently asked Zendesk questions and auto-add them to a Notion FAQ",
        prompt:
          "Set up a workflow that identifies recurring Zendesk questions, drafts FAQ entries, and adds them to our Notion knowledge base",
        connectors: ["zendesk", "notion", "slack"],
      },
      {
        title: "Jotform intake to Notion",
        description: "Form answers land in Notion with Slack notifications",
        prompt:
          "Set up a Jotform intake that routes new form submissions to the right Notion database and sends a Slack notification",
        connectors: ["jotform", "notion", "slack"],
      },
      {
        title: "Airtable deal tracker",
        description: "Deals sync to Sheets and Slack when they close",
        prompt:
          "Set up an Airtable deal tracker that syncs deal records to Google Sheets and sends a Slack notification when a deal is marked as closed-won",
        connectors: ["airtable", "google-sheets", "slack"],
      },
      {
        title: "SerpAPI keyword tracker",
        description: "Track keyword rankings weekly and log to Sheets",
        prompt:
          "Set up a weekly keyword ranking tracker using SerpAPI that monitors our target keywords and logs position changes to Google Sheets with a Slack summary",
        connectors: ["serpapi", "google-sheets", "slack"],
      },
      {
        title: "Perplexity deep research",
        description: "AI-powered research summaries saved to Notion",
        prompt:
          "Use Perplexity to research a topic in depth, compile findings into a structured Notion page with sources and key insights",
        connectors: ["perplexity", "notion"],
      },
      {
        title: "Runway video from brief",
        description: "Generate short videos from a creative brief",
        prompt:
          "Take a creative brief from Notion and generate a short promotional video using Runway, then notify the team on Slack when ready",
        connectors: ["runway", "notion", "slack"],
      },
      {
        title: "Fal AI image generation",
        description: "Generate product images from descriptions in Notion",
        prompt:
          "Set up a workflow that takes product descriptions from Notion, generates marketing images using Fal, and saves them to Google Drive",
        connectors: ["fal", "notion", "google-drive"],
      },
      {
        title: "Cloudinary media optimizer",
        description: "Optimize and transform images in bulk",
        prompt:
          "Set up a workflow that takes images from Google Drive, optimizes them with Cloudinary for web use, and logs the results in Notion",
        connectors: ["cloudinary", "google-drive", "notion"],
      },
    ],
  },
  {
    id: "workflows",
    title: "Workflows",
    cases: [
      {
        title: "Marketing automation system",
        description:
          "Three agents for research, weekly monitoring, and ad hoc work",
        prompt:
          "Set up a marketing automation system with three agents: a daily researcher for information collection, a weekly monitor for tracking, and an on-demand agent for ad-hoc tasks",
        connectors: ["slack"],
      },
      {
        title: "Linear PRD implementer",
        description: "Notion specs become Linear projects and issues",
        prompt:
          "Take the product spec from Notion and create a structured Linear project with epics and issues",
        connectors: ["notion", "linear"],
      },
      {
        title: "AgentMail inbox",
        description: "Create and manage inboxes with the AgentMail API",
        prompt:
          "Create a new AgentMail inbox and set up email forwarding rules",
        connectors: ["agentmail"],
      },
      {
        title: "Customer support bot",
        description: "Answers from the knowledge base and tasks for gaps",
        prompt:
          "Set up a customer support bot that answers questions from our Notion knowledge base and creates tasks for unanswered questions",
        connectors: ["slack", "notion"],
      },
      {
        title: "Feedback router",
        description: "Slack feedback routed by your rules to the right place",
        prompt:
          "Set up a feedback router that watches a Slack channel and routes messages to the right team based on keywords and labels",
        connectors: ["slack", "notion"],
      },
      {
        title: "HubSpot sales reporter",
        description: "Weekly HubSpot summaries saved as structured reports",
        prompt:
          "Generate a weekly HubSpot sales summary and save it as a structured report in Notion",
        connectors: ["hubspot", "notion"],
      },
      {
        title: "Discord community insights",
        description: "Discord feedback in Notion with a weekly Slack digest",
        prompt:
          "Set up a Discord community monitor that watches for feature requests and bug reports, categorizes them in Notion, and posts a weekly digest to Slack",
        connectors: ["discord", "notion", "slack"],
      },
      {
        title: "X brand monitor",
        description: "Brand mentions on X saved in Notion with team alerts",
        prompt:
          "Set up an X brand monitor that watches for mentions of our product, saves relevant posts to Notion, and sends Slack alerts for high-engagement posts",
        connectors: ["x", "notion", "slack"],
      },
      {
        title: "Asana \u2192 Notion project sync",
        description: "Asana milestones and tasks mirrored in Notion",
        prompt:
          "Set up a sync between Asana and Notion that mirrors project milestones, task progress, and due dates into a Notion dashboard",
        connectors: ["asana", "notion", "slack"],
      },
      {
        title: "ClickUp \u2192 Slack standups",
        description: "Daily ClickUp tasks posted as a standup in Slack",
        prompt:
          "Set up a daily standup that pulls each team member's tasks from ClickUp and posts a formatted summary to Slack every morning",
        connectors: ["clickup", "slack"],
      },
      {
        title: "Monday.com weekly digest",
        description: "Weekly board progress from Monday.com in Slack",
        prompt:
          "Set up a weekly Monday.com digest that summarizes board activity, completed items, and blockers, then posts to Slack",
        connectors: ["monday", "slack"],
      },
      {
        title: "Google Docs \u2192 Notion migrator",
        description: "Google Docs batches into Notion with layout preserved",
        prompt:
          "Set up a workflow that converts a folder of Google Docs into Notion pages, preserving headings, tables, and images",
        connectors: ["google-docs", "notion"],
      },
      {
        title: "Apify web scraper to Sheets",
        description: "Apify scrapes sites into structured Google Sheets rows",
        prompt:
          "Set up an Apify scraper that extracts product listings from a competitor website and saves them to Google Sheets daily",
        connectors: ["apify", "google-sheets", "slack"],
      },
      {
        title: "Wrike project reporter",
        description: "Weekly Wrike progress summaries in Slack",
        prompt:
          "Set up a weekly Wrike report that summarizes task completion, overdue items, and blockers across all projects, then posts to Slack",
        connectors: ["wrike", "slack"],
      },
      {
        title: "PDF contract processor",
        description: "Contract fields in Notion with reminders before expiry",
        prompt:
          "Set up a workflow that processes PDF contracts, extracts key dates and terms into Notion, and sends Slack reminders before expiration dates",
        connectors: ["pdfco", "notion", "slack"],
      },
      {
        title: "Zapier → VM0 migration",
        description: "Recreate your Zapier workflows as VM0 agents",
        prompt:
          "Help me migrate my Zapier workflows to VM0. I have zaps for: new Slack message → Notion, Gmail → Google Sheets, and GitHub PR → Slack",
        connectors: ["zapier", "slack", "notion"],
        featureFlag: FeatureSwitchKey.ZapierConnector,
      },
      {
        title: "Make scenario builder",
        description: "Design multi-step Make scenarios from a description",
        prompt:
          "Design a Make scenario that watches a Gmail inbox for invoices, extracts amounts and dates, logs them to Google Sheets, and alerts on Slack",
        connectors: ["make", "gmail", "google-sheets", "slack"],
      },
      {
        title: "Tavily web research pipeline",
        description: "Search the web and compile findings in Notion",
        prompt:
          "Use Tavily to research the latest trends in AI agents, compile a structured report in Notion with sources and key takeaways",
        connectors: ["tavily", "notion"],
      },
      {
        title: "Browserbase web testing",
        description: "Automated browser tests for your web app",
        prompt:
          "Set up automated browser tests using Browserbase that check our landing page, login flow, and dashboard every day and report failures to Slack",
        connectors: ["browserbase", "slack"],
      },
      {
        title: "Chatwoot → Notion support log",
        description: "Customer conversations logged and categorized in Notion",
        prompt:
          "Set up a workflow that takes Chatwoot customer conversations, categorizes them by topic, and creates structured entries in Notion",
        connectors: ["chatwoot", "notion", "slack"],
      },
      {
        title: "Bitrix24 lead nurture",
        description: "New Bitrix leads get follow-up tasks and Slack pings",
        prompt:
          "Set up a lead nurture workflow that monitors Bitrix24 for new leads, creates follow-up tasks, and notifies sales on Slack",
        connectors: ["bitrix", "slack"],
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
