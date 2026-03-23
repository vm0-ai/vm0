import type { ConnectorType } from "@vm0/core";

interface UseCase {
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly connectors?: readonly ConnectorType[];
}

interface Category {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly cases: readonly UseCase[];
}

const categories: readonly Category[] = [
  {
    id: "reports",
    title: "Automated Reports",
    subtitle:
      "Pull multi-source data on a schedule, generate and distribute reports automatically",
    cases: [
      {
        title: "Daily standup report",
        description:
          "Pull GitHub, Sentry, Axiom, and Plausible data every morning, generate a pptx, and post to a Slack channel",
        prompt:
          "Set up a daily standup report that pulls data from GitHub, Sentry, Axiom, and Plausible every morning, generates a pptx, and posts it to #all-vm0",
        connectors: ["github", "sentry", "axiom", "plausible", "slack"],
      },
      {
        title: "Personal weekly / daily digest",
        description:
          "Merge GitHub PRs, Gmail, and Calendar into a summary and deliver to Slack",
        prompt:
          "Create a personal weekly report workflow that merges GitHub PRs, Gmail, and Calendar data into a summary and sends it to Slack",
        connectors: ["github", "gmail", "google-calendar", "slack"],
      },
      {
        title: "GitHub progress weekly",
        description: "Summarize a week of GitHub activity by feature module",
        prompt:
          "Generate a weekly GitHub progress report summarized by feature modules",
        connectors: ["github"],
      },
      {
        title: "Morning brief",
        description:
          "Pull updates from Gmail, Calendar, and Notion to give you a clear plan for the day",
        prompt:
          "Set up a morning brief that pulls updates from Gmail, Calendar, and Notion every morning and posts a daily plan to Slack",
        connectors: ["gmail", "google-calendar", "notion", "slack"],
      },
      {
        title: "GitHub PR summarizer",
        description:
          "Summarize merged PRs over a time window and save a daily report to Notion",
        prompt:
          "Summarize all merged GitHub PRs from the past week and save a daily report in Notion with an optional Slack post",
        connectors: ["github", "notion", "slack"],
      },
      {
        title: "Sentry issue digest",
        description:
          "Daily morning summaries of Sentry issues with severity and suggested fixes",
        prompt:
          "Set up a daily Sentry issue digest that summarizes critical and high severity issues every morning and posts to Slack",
        connectors: ["sentry", "slack"],
      },
      {
        title: "PostHog funnel report",
        description:
          "Pull key product funnels from PostHog, aggregate in Google Sheets, and post a weekly digest to Slack",
        prompt:
          "Set up a weekly PostHog funnel report that pulls conversion data, logs it to Google Sheets, and posts a summary to Slack",
        connectors: ["posthog", "google-sheets", "slack"],
      },
      {
        title: "Vercel deploy digest",
        description:
          "Track Vercel deployments, correlate with GitHub commits, and alert on failures",
        prompt:
          "Set up a Vercel deploy digest that monitors deployments, links each to its GitHub commit, and sends Slack alerts on failures",
        connectors: ["vercel", "github", "slack"],
      },
      {
        title: "Ahrefs SEO weekly",
        description:
          "Pull weekly SEO rankings and backlink changes from Ahrefs, log to Google Sheets, and report to Slack",
        prompt:
          "Set up a weekly Ahrefs SEO report that tracks keyword rankings and backlink changes, logs data to Google Sheets, and posts a summary to Slack",
        connectors: ["ahrefs", "google-sheets", "slack"],
      },
      {
        title: "Cloudflare traffic & security report",
        description:
          "Summarize Cloudflare traffic analytics and security events into a weekly Slack digest",
        prompt:
          "Set up a weekly Cloudflare report that summarizes traffic analytics, WAF events, and bot activity, then posts to Slack",
        connectors: ["cloudflare", "slack"],
      },
      {
        title: "Metabase dashboard digest",
        description:
          "Snapshot key Metabase dashboards and post charts to Slack on a weekly schedule",
        prompt:
          "Set up a weekly Metabase digest that snapshots key dashboards, captures charts, and posts them to Slack every Monday morning",
        connectors: ["metabase", "slack"],
      },
      {
        title: "RevenueCat subscription digest",
        description:
          "Track subscription metrics from RevenueCat, log to Google Sheets, and alert on churn spikes",
        prompt:
          "Set up a daily RevenueCat digest that tracks new subscriptions, renewals, and cancellations in Google Sheets and alerts on Slack for churn spikes",
        connectors: ["revenuecat", "google-sheets", "slack"],
      },
      {
        title: "Xero financial summary",
        description:
          "Pull weekly P&L and cash flow data from Xero and post a financial summary to Slack",
        prompt:
          "Set up a weekly Xero financial summary that pulls profit & loss and cash flow data and posts a formatted report to Slack",
        connectors: ["xero", "slack"],
      },
    ],
  },
  {
    id: "github",
    title: "GitHub Operations",
    subtitle:
      "Batch-manage issues, investigate codebases, and surface security alerts",
    cases: [
      {
        title: "Batch-create issues",
        description:
          "Give Zero multiple issue instructions at once \u2014 it creates and assigns them automatically",
        prompt:
          "Create the following GitHub issues and assign them to the right people: 1) ... 2) ... 3) ...",
        connectors: ["github"],
      },
      {
        title: "Codebase investigation",
        description:
          "Send a page URL and let Zero search the codebase to find the root cause",
        prompt:
          "Look at this page and search the codebase to find the root cause of the bug: [paste URL]",
        connectors: ["github"],
      },
      {
        title: "Deep-research code analysis",
        description:
          "Deep-dive into technical implementations like locking mechanisms or queue architecture",
        prompt:
          "Do a deep research on how the agent run queue locking mechanism works in our codebase",
        connectors: ["github"],
      },
      {
        title: "Security & dependency alert digest",
        description:
          "Surface a weekly digest of security and dependency alerts from GitHub",
        prompt:
          "Generate a weekly GitHub security and dependency alert digest and post it to Slack",
        connectors: ["github", "slack"],
      },
      {
        title: "Jira \u2194 GitHub issue sync",
        description:
          "Keep Jira tickets and GitHub issues in sync, with bidirectional status updates",
        prompt:
          "Set up a bidirectional sync between Jira and GitHub so that issue status, labels, and comments stay in sync across both platforms",
        connectors: ["jira", "github", "slack"],
      },
      {
        title: "GitLab to GitHub migration helper",
        description:
          "Mirror GitLab issues and MRs to GitHub issues and PRs for cross-platform teams",
        prompt:
          "Set up a workflow that mirrors GitLab issues to GitHub issues and notifies on Slack when new items are synced",
        connectors: ["gitlab", "github", "slack"],
      },
      {
        title: "Supabase health monitor",
        description:
          "Monitor Supabase database health, connection pool usage, and alert on anomalies",
        prompt:
          "Set up a Supabase health monitor that checks database metrics, connection pool usage, and sends Slack alerts for anomalies",
        connectors: ["supabase", "slack"],
      },
    ],
  },
  {
    id: "collaboration",
    title: "Daily Collaboration",
    subtitle:
      "Inbox summaries, calendar optimization, proxy messages, and more",
    cases: [
      {
        title: "Email assistant",
        description:
          "Summarize your inbox each morning and suggest whether to keep, archive, or reply",
        prompt:
          "Set up a daily email assistant that summarizes my inbox every morning and suggests actions for each thread",
        connectors: ["gmail"],
      },
      {
        title: "Calendar optimizer",
        description:
          "Analyze your daily calendar and recommend how to manage conflicts and schedule focus time",
        prompt:
          "Analyze my calendar for today and recommend how to manage conflicts, prevent overload, and schedule focus time",
        connectors: ["google-calendar"],
      },
      {
        title: "Send messages on your behalf",
        description:
          "Have Zero post leave notices or announcements to the team as itself",
        prompt:
          "Send a message to the team on my behalf: I'll be taking a day off tomorrow. Please reach out to [name] for urgent matters.",
        connectors: ["slack"],
      },
      {
        title: "Browser screenshots",
        description:
          "Have Zero open a URL in agent-browser and return a screenshot",
        prompt:
          "Open this URL in the browser and take a screenshot: [paste URL]",
      },
      {
        title: "Self-update instructions",
        description: "Tell Zero to update its own instructions on the fly",
        prompt: "Update yourself: add the following instructions \u2014 ...",
      },
      {
        title: "Support ticket router",
        description:
          "Route incoming Gmail support emails to Notion by category and priority, alert on Slack for critical ones",
        prompt:
          "Set up a support ticket router that monitors Gmail for support emails, classifies them by category and priority, creates Notion entries, and sends Slack alerts for critical tickets",
        connectors: ["gmail", "notion", "slack"],
      },
      {
        title: "Meeting notes pipeline",
        description:
          "Auto-transcribe meetings with Fireflies, summarize to Notion, and post action items to Slack",
        prompt:
          "Set up a meeting notes pipeline that takes Fireflies transcripts, generates a summary in Notion, and posts action items to Slack after each meeting",
        connectors: ["fireflies", "notion", "slack"],
      },
      {
        title: "Calendly booking sync",
        description:
          "Sync new Calendly bookings to Google Calendar and notify the team on Slack",
        prompt:
          "Set up a Calendly sync that adds new bookings to Google Calendar and sends a Slack notification with meeting details",
        connectors: ["calendly", "google-calendar", "slack"],
      },
      {
        title: "Outlook inbox digest",
        description:
          "Summarize your Outlook inbox each morning with priority flags and suggested actions",
        prompt:
          "Set up a daily Outlook inbox digest that summarizes emails by priority and suggests actions, then posts to Slack",
        connectors: ["outlook-mail", "slack"],
      },
      {
        title: "Todoist \u2192 Notion task sync",
        description:
          "Sync personal Todoist tasks into a Notion team workspace for visibility",
        prompt:
          "Set up a sync that mirrors my Todoist tasks into a Notion database so the team can see what I'm working on",
        connectors: ["todoist", "notion"],
      },
      {
        title: "Lark \u2194 Slack message relay",
        description:
          "Bridge Lark and Slack channels so messages in one appear in the other",
        prompt:
          "Set up a message relay between a Lark group and a Slack channel so that messages are forwarded both ways",
        connectors: ["lark", "slack"],
      },
      {
        title: "Google Drive file organizer",
        description:
          "Auto-organize new Google Drive files into folders based on file type and content",
        prompt:
          "Set up a workflow that watches Google Drive for new files, classifies them by content, and moves them into the right folders",
        connectors: ["google-drive"],
      },
      {
        title: "Deel payroll notifier",
        description:
          "Notify the team on Slack when Deel payroll is processed or contracts are updated",
        prompt:
          "Set up a Deel notifier that sends Slack messages when payroll is processed, new contracts are created, or invoices are due",
        connectors: ["deel", "slack"],
      },
    ],
  },
  {
    id: "content",
    title: "Content & Product",
    subtitle:
      "Content planning, GTM strategy, user research, and pricing analysis",
    cases: [
      {
        title: "Content planner",
        description:
          "Brainstorm content ideas, plan your editorial calendar, and structure posts and newsletters",
        prompt:
          "Help me brainstorm content ideas and plan an editorial calendar for the next month in Notion",
        connectors: ["notion"],
      },
      {
        title: "Marketing content planning",
        description:
          "Plan GTM use-case content referencing Slack usage, user interviews, and competitors",
        prompt:
          "Help me plan GTM use case content. Reference our team's Slack usage patterns, user interviews, and competitor analysis",
        connectors: ["slack"],
      },
      {
        title: "Onboarding email use cases",
        description:
          "Analyze Slack history and user interviews to extract onboarding use cases",
        prompt:
          "Analyze our Slack usage records and user interviews to extract key onboarding use cases for email campaigns",
        connectors: ["slack"],
      },
      {
        title: "Product copy & naming",
        description:
          "Brainstorm user-friendly alternatives for technical terms in your UI",
        prompt:
          'Suggest user-friendly alternative names for "logs" in our product UI',
      },
      {
        title: "Competitor research to Notion",
        description:
          "Research a competitor on X/Twitter and save findings to a Notion database",
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
        description:
          "Generate platform-optimized posts from a Google Sheets editorial calendar",
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
          "Scrape competitor websites with Firecrawl, extract key changes, and log findings to Notion",
        prompt:
          "Set up a weekly competitor scraper using Firecrawl that monitors competitor websites for pricing and feature changes, saves findings to Notion, and alerts on Slack",
        connectors: ["firecrawl", "notion", "slack"],
      },
      {
        title: "Figma design handoff",
        description:
          "Monitor Figma file updates and auto-create Linear issues for each changed component",
        prompt:
          "Set up a design handoff workflow that watches a Figma file for updates and creates Linear issues for changed components, notifying the dev team on Slack",
        connectors: ["figma", "linear", "slack"],
      },
      {
        title: "Dev.to auto-publisher",
        description:
          "Publish blog posts from Notion to Dev.to and share on X when they go live",
        prompt:
          "Set up a workflow that publishes Notion pages tagged as 'ready' to Dev.to and posts a link on X",
        connectors: ["devto", "notion", "x"],
      },
      {
        title: "Instagram engagement tracker",
        description:
          "Track Instagram post engagement and log metrics to Google Sheets with weekly Slack reports",
        prompt:
          "Set up an Instagram tracker that logs post engagement metrics to Google Sheets and posts a weekly summary to Slack",
        connectors: ["instagram", "google-sheets", "slack"],
      },
      {
        title: "Mailchimp campaign reporter",
        description:
          "Pull Mailchimp campaign open rates and clicks, save to Google Sheets, and post a digest to Slack",
        prompt:
          "Set up a Mailchimp campaign report that pulls open rates, click rates, and unsubscribes after each send, logs to Google Sheets, and posts to Slack",
        connectors: ["mailchimp", "google-sheets", "slack"],
      },
      {
        title: "SimilarWeb traffic comparison",
        description:
          "Compare your website traffic against competitors using SimilarWeb and save to Notion",
        prompt:
          "Run a monthly SimilarWeb traffic comparison between our site and top 5 competitors, save the report to Notion",
        connectors: ["similarweb", "notion"],
      },
      {
        title: "ElevenLabs audio content",
        description:
          "Generate voice narration from Notion articles and save audio files to Google Drive",
        prompt:
          "Set up a workflow that takes blog posts from Notion, generates voice narration with ElevenLabs, and saves the audio to Google Drive",
        connectors: ["elevenlabs", "notion", "google-drive"],
      },
      {
        title: "HeyGen video from script",
        description:
          "Turn a Notion script into an AI-generated video with HeyGen and notify the team",
        prompt:
          "Set up a workflow that takes a script from Notion, generates a video with HeyGen, and sends a Slack notification when it's ready",
        connectors: ["heygen", "notion", "slack"],
      },
    ],
  },
  {
    id: "sales",
    title: "Sales & CRM",
    subtitle:
      "Lead qualification, deal tracking, pipeline reporting, and customer sync",
    cases: [
      {
        title: "Lead follow-up pipeline",
        description:
          "Capture lead emails, analyze intent and urgency, create HubSpot tasks, and notify sales on Slack",
        prompt:
          "Set up a lead follow-up pipeline that monitors Gmail for new leads, analyzes them with AI, creates HubSpot tasks, and notifies the sales team on Slack",
        connectors: ["gmail", "hubspot", "slack"],
      },
      {
        title: "Stripe customer sync",
        description:
          "Automatically create Stripe customers and payment links when new entries are added to Notion",
        prompt:
          "Set up a Stripe sync that creates a Stripe customer and payment link whenever a new client is added to our Notion database",
        connectors: ["stripe", "notion"],
      },
      {
        title: "Win/loss reporter",
        description:
          "Analyze your sales pipeline to track wins and losses, then deliver trends to Slack",
        prompt:
          "Set up a weekly win/loss report that analyzes our HubSpot pipeline, tracks deal outcomes, and posts trends to Slack",
        connectors: ["hubspot", "slack"],
      },
      {
        title: "Intercom conversation triager",
        description:
          "Turn Intercom customer conversations into structured Notion tasks with priority labels",
        prompt:
          "Set up a workflow that takes Intercom conversations, classifies them, and creates structured tasks in Notion",
        connectors: ["intercom", "notion"],
      },
      {
        title: "DocuSign contract tracker",
        description:
          "When contracts are signed in DocuSign, update deal status in Notion and notify the team",
        prompt:
          "Set up a contract tracker that monitors DocuSign for completed signatures, updates the deal page in Notion, and sends a Slack notification",
        connectors: ["docusign", "notion", "slack"],
      },
      {
        title: "Meta Ads spend tracker",
        description:
          "Pull daily Meta Ads spend and performance data to Google Sheets with Slack alerts on budget thresholds",
        prompt:
          "Set up a daily Meta Ads tracker that logs spend and performance to Google Sheets and alerts on Slack when budget thresholds are reached",
        connectors: ["meta-ads", "google-sheets", "slack"],
      },
      {
        title: "Salesforce pipeline digest",
        description:
          "Summarize Salesforce pipeline changes weekly and post opportunity updates to Slack",
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
        description:
          "Route Jotform submissions to Notion databases with Slack notifications for new entries",
        prompt:
          "Set up a Jotform intake that routes new form submissions to the right Notion database and sends a Slack notification",
        connectors: ["jotform", "notion", "slack"],
      },
      {
        title: "Airtable deal tracker",
        description:
          "Sync Airtable deal records to Google Sheets and send Slack alerts when deals close",
        prompt:
          "Set up an Airtable deal tracker that syncs deal records to Google Sheets and sends a Slack notification when a deal is marked as closed-won",
        connectors: ["airtable", "google-sheets", "slack"],
      },
    ],
  },
  {
    id: "workflows",
    title: "Team-Built Workflows",
    subtitle:
      "Multi-agent systems, cross-tool pipelines, and automated operations",
    cases: [
      {
        title: "Marketing automation system",
        description:
          "Three agents working together: daily researcher, weekly monitor, and on-demand tasks",
        prompt:
          "Set up a marketing automation system with three agents: a daily researcher for information collection, a weekly monitor for tracking, and an on-demand agent for ad-hoc tasks",
        connectors: ["slack"],
      },
      {
        title: "Linear PRD implementer",
        description:
          "Turn Notion product docs into well-structured Linear projects and issues",
        prompt:
          "Take the product spec from Notion and create a structured Linear project with epics and issues",
        connectors: ["notion", "linear"],
      },
      {
        title: "Notion + Resend email pipeline",
        description:
          "Pull content from Notion, assemble into a template, and send via Resend",
        prompt:
          "Create a workflow that takes content from Notion, assembles it into an email template, and sends it via Resend",
        connectors: ["notion", "resend"],
      },
      {
        title: "Local file access via vm0-computer",
        description:
          "Connect to your local machine via connector and let agents read local files",
        prompt:
          "Connect to my local computer via vm0-computer connector and read files from my desktop",
        connectors: ["computer"],
      },
      {
        title: "AgentMail inbox",
        description:
          "Create and manage email inboxes through the AgentMail API",
        prompt:
          "Create a new AgentMail inbox and set up email forwarding rules",
        connectors: ["agentmail"],
      },
      {
        title: "Customer support bot",
        description:
          "Auto-answer customer questions from your knowledge base and create tasks for gaps",
        prompt:
          "Set up a customer support bot that answers questions from our Notion knowledge base and creates tasks for unanswered questions",
        connectors: ["slack", "notion"],
      },
      {
        title: "Feedback router",
        description:
          "Route Slack feedback by matching messages to your rules and taking specified actions",
        prompt:
          "Set up a feedback router that watches a Slack channel and routes messages to the right team based on keywords and labels",
        connectors: ["slack", "notion"],
      },
      {
        title: "HubSpot sales reporter",
        description:
          "Generate weekly HubSpot sales summaries and save them as structured reports",
        prompt:
          "Generate a weekly HubSpot sales summary and save it as a structured report in Notion",
        connectors: ["hubspot", "notion"],
      },
      {
        title: "Discord community insights",
        description:
          "Monitor Discord for feature requests and bug reports, categorize in Notion, weekly digest to Slack",
        prompt:
          "Set up a Discord community monitor that watches for feature requests and bug reports, categorizes them in Notion, and posts a weekly digest to Slack",
        connectors: ["discord", "notion", "slack"],
      },
      {
        title: "Reddit brand monitor",
        description:
          "Watch Reddit for brand mentions, save relevant threads to Notion, and alert the team",
        prompt:
          "Set up a Reddit brand monitor that watches for mentions of our product, saves relevant threads to Notion, and sends Slack alerts for high-engagement posts",
        connectors: ["reddit", "notion", "slack"],
      },
      {
        title: "Mercury cash flow monitor",
        description:
          "Track Mercury transactions, log to Google Sheets, and alert on large or unusual movements",
        prompt:
          "Set up a cash flow monitor that tracks Mercury bank transactions, logs them to Google Sheets, and sends Slack alerts for transactions above a threshold",
        connectors: ["mercury", "google-sheets", "slack"],
      },
      {
        title: "Webflow CMS publish monitor",
        description:
          "Track new Webflow CMS items and notify the team with a Slack post linking to the live page",
        prompt:
          "Set up a Webflow monitor that sends a Slack notification whenever a new CMS item is published, with a link to the live page",
        connectors: ["webflow", "slack"],
      },
      {
        title: "Asana \u2192 Notion project sync",
        description:
          "Mirror Asana project milestones and tasks to Notion for cross-team visibility",
        prompt:
          "Set up a sync between Asana and Notion that mirrors project milestones, task progress, and due dates into a Notion dashboard",
        connectors: ["asana", "notion", "slack"],
      },
      {
        title: "ClickUp \u2192 Slack standups",
        description:
          "Pull today's tasks from ClickUp and post a formatted daily standup to Slack",
        prompt:
          "Set up a daily standup that pulls each team member's tasks from ClickUp and posts a formatted summary to Slack every morning",
        connectors: ["clickup", "slack"],
      },
      {
        title: "Monday.com weekly digest",
        description:
          "Summarize Monday.com board activity and post a weekly progress digest to Slack",
        prompt:
          "Set up a weekly Monday.com digest that summarizes board activity, completed items, and blockers, then posts to Slack",
        connectors: ["monday", "slack"],
      },
      {
        title: "Google Docs \u2192 Notion migrator",
        description:
          "Batch-convert Google Docs into Notion pages while preserving formatting and images",
        prompt:
          "Set up a workflow that converts a folder of Google Docs into Notion pages, preserving headings, tables, and images",
        connectors: ["google-docs", "notion"],
      },
      {
        title: "Dropbox \u2192 Google Drive sync",
        description:
          "Mirror specific Dropbox folders to Google Drive for cross-platform access",
        prompt:
          "Set up a sync that mirrors files from a Dropbox folder to Google Drive and notifies on Slack when new files are synced",
        connectors: ["dropbox", "google-drive", "slack"],
      },
      {
        title: "Apify web scraper to Sheets",
        description:
          "Run Apify actors to scrape data from any website and save structured results to Google Sheets",
        prompt:
          "Set up an Apify scraper that extracts product listings from a competitor website and saves them to Google Sheets daily",
        connectors: ["apify", "google-sheets", "slack"],
      },
      {
        title: "Canva design tracker",
        description:
          "Monitor Canva team designs and log new assets to Notion with Slack notifications",
        prompt:
          "Set up a Canva tracker that logs new team designs to a Notion asset library and notifies the marketing channel on Slack",
        connectors: ["canva", "notion", "slack"],
      },
      {
        title: "Wrike project reporter",
        description:
          "Summarize Wrike project progress and post weekly reports to Slack",
        prompt:
          "Set up a weekly Wrike report that summarizes task completion, overdue items, and blockers across all projects, then posts to Slack",
        connectors: ["wrike", "slack"],
      },
      {
        title: "PDF contract processor",
        description:
          "Extract key fields from PDF contracts, save structured data to Notion, and alert on upcoming expirations",
        prompt:
          "Set up a workflow that processes PDF contracts, extracts key dates and terms into Notion, and sends Slack reminders before expiration dates",
        connectors: ["pdfco", "notion", "slack"],
      },
      {
        title: "Deel payroll report",
        description:
          "Track Deel payroll events, log to Google Sheets, and post monthly summaries to Slack",
        prompt:
          "Set up a monthly Deel payroll report that logs all payroll events to Google Sheets and posts a summary to Slack",
        connectors: ["deel", "google-sheets", "slack"],
      },
    ],
  },
];

export function getCategories(): readonly Category[] {
  return categories;
}

export function getRandomPrompts(count: number): UseCase[] {
  const all = categories.flatMap((c) =>
    c.cases.filter((u) => u.connectors && u.connectors.length > 0),
  );
  const shuffled = [...all].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}
