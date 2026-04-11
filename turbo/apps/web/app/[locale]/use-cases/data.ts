// ---------------------------------------------------------------------------
// Use Cases – types & static data
// ---------------------------------------------------------------------------

export type Role = "engineering" | "product" | "ops" | "everyone";
export type Capability = "multi-tool" | "scheduled" | "instant";

export interface ConnectorRef {
  id: string;
  label: string;
  icon: string;
  darkIcon?: string;
}

export interface SlackMessage {
  role: "user" | "zero";
  name: string;
  text: string;
}

export interface PromptVariant {
  label: string;
  prompt: string;
}

export interface NextAction {
  title: string;
  description: string;
  examplePrompt: string;
}

export interface Integration {
  connector: ConnectorRef;
  description: string;
  required: boolean;
}

export interface UseCaseSectionHeadings {
  scenario: string;
  prompt: string;
  steps: string;
  nextActions: string;
  integrations: string;
  tips: string;
}

export interface AvatarConfig {
  rotation: number;
  skin: number;
  hairStyle: number;
  hairColor: number;
  expression: number;
  intensity: string;
}

export interface UseCase {
  slug: string;
  title: string;
  description: string;
  color: string;
  avatar: AvatarConfig;
  roles: Role[];
  capability: Capability;
  timeSaved: string;
  model: string;
  videoId?: string;
  connectors: ConnectorRef[];
  slackPreview: SlackMessage[];
  headings: UseCaseSectionHeadings;
  scenario: string;
  promptVariants: PromptVariant[];
  steps: { title: string; description: string }[];
  nextActions: NextAction[];
  integrations: Integration[];
  tips: string[];
  relatedSlugs: string[];
}

// ---------------------------------------------------------------------------
// Connector refs (reusable across use cases)
// ---------------------------------------------------------------------------

const SLACK: ConnectorRef = {
  id: "slack",
  label: "Slack",
  icon: "/assets/mockup/slack.svg",
};

const SENTRY: ConnectorRef = {
  id: "sentry",
  label: "Sentry",
  icon: "/assets/connectors/sentry.svg",
};

const GITHUB: ConnectorRef = {
  id: "github",
  label: "GitHub",
  icon: "/assets/connectors/github.svg",
};

const GMAIL: ConnectorRef = {
  id: "gmail",
  label: "Gmail",
  icon: "/assets/connectors/gmail.svg",
};

const GOOGLE_CALENDAR: ConnectorRef = {
  id: "google-calendar",
  label: "Calendar",
  icon: "/assets/connectors/google-calendar.svg",
};

const LINEAR: ConnectorRef = {
  id: "linear",
  label: "Linear",
  icon: "/assets/connectors/linear.svg",
};

const X_TWITTER: ConnectorRef = {
  id: "x",
  label: "X (Twitter)",
  icon: "/assets/connectors/x.svg",
};

const NOTION: ConnectorRef = {
  id: "notion",
  label: "Notion",
  icon: "/assets/connectors/notion.svg",
};

const AXIOM: ConnectorRef = {
  id: "axiom",
  label: "Axiom",
  icon: "/assets/connectors/axiom.svg",
};

const V0: ConnectorRef = {
  id: "v0",
  label: "v0",
  icon: "/assets/connectors/v0.svg",
};

const VERCEL: ConnectorRef = {
  id: "vercel",
  label: "Vercel",
  icon: "/assets/connectors/vercel.svg",
};

// ---------------------------------------------------------------------------
// Full use cases
// ---------------------------------------------------------------------------

export const USE_CASES: UseCase[] = [
  {
    slug: "sentry-triage",
    title: "Turn Sentry noise into a prioritized action list",
    description:
      "Ask Zero to pull your top unresolved Sentry errors, ranked by frequency. Zero reads the stack traces, explains the root cause in plain language, and tells you which file to fix first.",
    color: "#d4a96a",
    videoId: "iTYhvVp5z5k",
    avatar: {
      rotation: 1,
      skin: 1,
      hairStyle: 3,
      hairColor: 2,
      expression: 3,
      intensity: "d",
    },
    roles: ["engineering"],
    capability: "multi-tool",
    timeSaved: "~25 min saved",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, SENTRY, AXIOM, GITHUB],
    slackPreview: [
      {
        role: "user",
        name: "Yuma",
        text: "@Zero look at recent failures on Sentry. Rank by frequency. Top 3 with detailed error stacks.",
      },
      {
        role: "zero",
        name: "Zero",
        text: "Here's the full Sentry failure report.\n\n#\tIssue\tCount\tPriority\n1\tSlack missing_scope\t57\tHigh\n2\tUnknown Stripe price ID\t15\tHigh\n3\tZeroSidebar .map()\t10\tMed",
      },
    ],
    headings: {
      scenario: "Why Sentry triage wastes engineering time",
      prompt: "How to ask Zero to triage Sentry errors",
      steps: "How Zero analyzes and ranks your Sentry errors",
      nextActions: "Turn Sentry triage into GitHub issues and daily automation",
      integrations: "Required integrations: Sentry and GitHub",
      tips: "Best practices for automated Sentry triage",
    },
    scenario:
      "Monday morning. You open Slack and there are a dozen Sentry alerts in #dev. Most of them are noise, flaky tests, known issues, transient errors that resolve themselves. But somewhere in there might be something real: a broken integration, a billing bug, a crash that's hitting actual users. You don't want to open Sentry's dashboard and click through issues one by one. You just want to know: which ones matter, how bad are they, and what's causing them.",
    promptVariants: [
      {
        label: "Detailed",
        prompt:
          "@Zero take a look at the recent failures on Sentry. Please rank the failures from the last 24 hours by their occurrence frequency.\n\nFor the top three failures, provide me with a report that includes the expanded, detailed error stacks.",
      },
      {
        label: "Quick",
        prompt: "@Zero top 3 Sentry errors in the last 24h, ranked by count.",
      },
      {
        label: "Scheduled",
        prompt:
          "@Zero every weekday at 9am, run this same Sentry check and post results to #dev. Only include errors with 5+ occurrences.",
      },
    ],
    steps: [
      {
        title: "Zero connects to Sentry",
        description:
          "Zero pulls unresolved issues from your Sentry project for the specified time window and ranks them by occurrence count.",
      },
      {
        title: "Summary table",
        description:
          "Zero replies in the same Slack thread with a quick summary table, issue name, occurrence count, and priority level, that you can scan in 5 seconds.",
      },
      {
        title: "Detailed analysis",
        description:
          'For each top issue, Zero provides annotated stack traces and plain-language root cause explanations. For example, it doesn\'t just say "Unknown Stripe price ID", it explains that a new price was likely created in Stripe but the corresponding mapping was not updated.',
      },
    ],
    nextActions: [
      {
        title: "Turn findings into action",
        description: "Create GitHub issues from the report",
        examplePrompt:
          "@Zero create GitHub issues for #1 and #2. Assign #1 to Lancy (Slack scope fix) and #2 to James (Stripe mapping). Label both as bug, priority high.",
      },
      {
        title: "Go deeper",
        description: "Ask Zero to investigate a specific error",
        examplePrompt:
          "@Zero for issue #1, what exact Slack OAuth scope is missing? Check our app manifest and tell me what to add.",
      },
      {
        title: "Make it a routine",
        description: "Schedule this as a daily check",
        examplePrompt:
          "@Zero every weekday at 9am, run this same Sentry check and post results to #dev. Only include errors with 5+ occurrences.",
      },
    ],
    integrations: [
      {
        connector: SENTRY,
        description:
          "OAuth connection to your Sentry org. Zero needs read access to issues and events.",
        required: true,
      },
      {
        connector: GITHUB,
        description:
          "Only needed if you want Zero to create issues from the report. Read/write access to issues.",
        required: false,
      },
    ],
    tips: [
      'Be specific about the time window. "last 24 hours" for daily triage, "errors since the last deploy" for post-deploy checks.',
      "Add a severity filter to reduce noise, only show errors with 10+ occurrences or skip errors tagged as known-issue.",
      "Chain it into your standup, combine with the standup use case for a morning brief that includes both your task summary and the Sentry report.",
    ],
    relatedSlugs: [
      "file-bugs-from-slack",
      "kol-cold-outreach",
      "standup-summary",
    ],
  },

  {
    slug: "standup-summary",
    title: "Get your standup ready without opening 5 apps",
    description:
      "Zero pulls from calendar, email, and Linear, then writes a shareable summary you can paste straight into the team thread.",
    color: "#c89090",
    videoId: "0D7ScfH4fwk",
    avatar: {
      rotation: 2,
      skin: 3,
      hairStyle: 5,
      hairColor: 4,
      expression: 1,
      intensity: "m",
    },
    roles: ["everyone"],
    capability: "multi-tool",
    timeSaved: "~20 min saved",
    model: "GPT-4o",
    connectors: [GOOGLE_CALENDAR, GMAIL, LINEAR, NOTION],
    slackPreview: [
      {
        role: "user",
        name: "Alex",
        text: "@Zero check my calendar, emails, and Linear tasks since yesterday and write me a work summary",
      },
      {
        role: "zero",
        name: "Zero",
        text: "Work Summary: Mar 23\u201324\n\nMeetings\n\u2022 Daily standups (10\u201310:30 AM)\n\u2022 VM0 User Interview w/ Daniel Miller\n\nEngineering\n\u2022 PR #5467 merged, firewall permissions\n\u2022 PR #6277 in review. Lighthouse at 36",
      },
    ],
    headings: {
      scenario: "The daily standup scramble across Calendar, Gmail, and Linear",
      prompt: "How to ask Zero for a standup summary",
      steps: "How Zero compiles your work summary from 3 tools",
      nextActions: "Post to Slack, add blockers, or automate daily",
      integrations: "Required integrations: Google Calendar, Gmail, and Linear",
      tips: "Best practices for AI-generated standup summaries",
    },
    scenario:
      "It's 9:50 AM and standup starts in 10 minutes. You haven't checked your calendar yet. You ask Zero to pull yesterday's meetings, emails, and Linear tasks, it writes a summary you can paste straight into the team thread.",
    promptVariants: [
      {
        label: "Detailed",
        prompt:
          "@Zero check my calendar, emails, and Linear tasks since yesterday and write me a work summary. Include meeting highlights and PR status.",
      },
      {
        label: "Quick",
        prompt: "@Zero what did I do yesterday? Check calendar and Linear.",
      },
      {
        label: "Scheduled",
        prompt:
          "@Zero every weekday at 9:45am, write my standup summary and DM it to me.",
      },
    ],
    steps: [
      {
        title: "Zero checks your calendar",
        description:
          "Zero reads your Google Calendar events from the past 24 hours and extracts meeting names, times, and attendees.",
      },
      {
        title: "Zero scans email and tasks",
        description:
          "Zero checks Gmail for relevant threads and Linear for tasks you updated, completed, or were assigned since yesterday.",
      },
      {
        title: "Formatted summary",
        description:
          "Zero compiles everything into a clean, copy-paste-ready summary organized by Meetings, Engineering work, and action items.",
      },
    ],
    nextActions: [
      {
        title: "Post directly to a channel",
        description: "Have Zero post the summary to #standup",
        examplePrompt: "@Zero post this summary to #standup and tag @team-eng.",
      },
      {
        title: "Add context",
        description: "Ask Zero to include blockers or priorities",
        examplePrompt:
          "@Zero also check my Linear for any blocked tasks and add them as blockers in the summary.",
      },
      {
        title: "Make it daily",
        description: "Automate your morning prep",
        examplePrompt:
          "@Zero every weekday at 9:45am, write my standup summary and DM it to me.",
      },
    ],
    integrations: [
      {
        connector: GOOGLE_CALENDAR,
        description:
          "OAuth connection to Google Calendar. Zero needs read access to your events.",
        required: true,
      },
      {
        connector: GMAIL,
        description:
          "OAuth connection to Gmail. Zero needs read access to scan recent threads.",
        required: true,
      },
      {
        connector: LINEAR,
        description:
          "OAuth connection to Linear. Zero reads your assigned and updated tasks.",
        required: true,
      },
    ],
    tips: [
      'Tell Zero your standup format if it differs from the default. "use the format: Yesterday / Today / Blockers".',
      'Specify the time window. "since yesterday 5pm" if you work late.',
      "Combine with Sentry triage for a complete engineering morning brief.",
    ],
    relatedSlugs: [
      "sentry-triage",
      "kol-cold-outreach",
      "file-bugs-from-slack",
    ],
  },

  {
    slug: "kol-cold-outreach",
    title: "Research a KOL on X and draft a personalized cold email",
    description:
      "Give Zero an X handle. It reads their last 30 posts, understands their style and interests, writes a personalized outreach email under 150 words, and saves it as a Gmail draft.",
    color: "#c4a08a",
    videoId: "aignt_fZSVo",
    avatar: {
      rotation: 1,
      skin: 2,
      hairStyle: 1,
      hairColor: 1,
      expression: 3,
      intensity: "m",
    },
    roles: ["product"],
    capability: "multi-tool",
    timeSaved: "~20 min saved",
    model: "Claude 4 Sonnet",
    connectors: [X_TWITTER, GMAIL, NOTION, SLACK],
    slackPreview: [
      {
        role: "user",
        name: "Scarlett",
        text: "@Zero read @swyx's last 30 X posts, understand his style, and draft a cold outreach email for a VM0 partnership. Save as Gmail draft.",
      },
      {
        role: "zero",
        name: "Zero",
        text: "Done. Analyzed @swyx's recent content:\n\u2022 Focus: AI agents, developer tools, open source\n\u2022 Tone: Technical but conversational\n\u2022 Audience fit: High (9/10)\n\nGmail draft saved: \"Agents that ship real work, thought you'd find this interesting\"",
      },
    ],
    headings: {
      scenario: "Why generic cold outreach gets ignored",
      prompt: "How to research a KOL and draft personalized outreach",
      steps: "How Zero analyzes X profiles and crafts tailored emails",
      nextActions:
        "Score KOL fit, batch multiple outreach drafts, or track in Notion CRM",
      integrations: "Required integrations: X, Gmail, and Notion",
      tips: "Best practices for AI-assisted KOL outreach",
    },
    scenario:
      "You found a KOL who'd be perfect for a partnership, but writing a cold email that doesn't feel generic takes 20 minutes of research, reading their posts, understanding what they care about, finding the right angle. You give Zero their X handle and get a personalized draft in seconds.",
    promptVariants: [
      {
        label: "Detailed",
        prompt:
          "@Zero read @swyx's last 30 X posts to understand their style and interests. Write a personalized cold outreach email under 150 words about a VM0 partnership. Reference something specific they posted recently. Save it as a Gmail draft.",
      },
      {
        label: "Quick",
        prompt:
          "@Zero draft a cold email to @swyx about VM0, based on their X posts. Save as Gmail draft.",
      },
      {
        label: "Batch",
        prompt:
          '@Zero for each handle in my Notion KOL list marked as "Not contacted", research their X profile and draft a personalized outreach email. Save all as Gmail drafts.',
      },
    ],
    steps: [
      {
        title: "Zero reads the KOL's X profile",
        description:
          "Zero pulls the last 30 posts, analyzes content themes, tone, audience, and engagement patterns to build a profile of what this person cares about.",
      },
      {
        title: "Personalized email drafted",
        description:
          "Zero writes a concise outreach email that references specific content the KOL posted, explains the relevance of your product, and uses a tone that matches their style.",
      },
      {
        title: "Draft saved to Gmail",
        description:
          "The email is saved as a Gmail draft ready for your review. Zero also updates the KOL's status in your Notion CRM if connected.",
      },
    ],
    nextActions: [
      {
        title: "Score KOL fit",
        description: "Rate how well a KOL matches your audience",
        examplePrompt:
          "@Zero analyze @swyx's audience overlap with VM0's ICP. Score 1-10 with reasoning and save to Notion.",
      },
      {
        title: "Batch outreach",
        description: "Draft emails for multiple KOLs at once",
        examplePrompt:
          "@Zero for the top 10 KOLs in my Notion list, research each and draft personalized outreach emails.",
      },
    ],
    integrations: [
      {
        connector: X_TWITTER,
        description:
          "Zero reads public posts to understand the KOL's style and interests.",
        required: true,
      },
      {
        connector: GMAIL,
        description: "Zero saves the drafted email to your Gmail drafts.",
        required: true,
      },
      {
        connector: NOTION,
        description:
          "Optional, track KOL status and fit scores in your Notion CRM.",
        required: false,
      },
    ],
    tips: [
      'Give Zero context about your product angle. "focus on how VM0 helps developer tool companies".',
      'Ask for multiple variants. "draft 2 versions: one casual, one professional".',
      "Always review before sending. Zero gets the research right, but the final voice should be yours.",
    ],
    relatedSlugs: ["file-bugs-from-slack", "slack-triage", "standup-summary"],
  },

  {
    slug: "file-bugs-from-slack",
    title: "File bugs from Slack without switching context",
    description:
      "Describe the issue in plain language. Zero creates a formatted GitHub issue, labels it, and assigns the right person.",
    color: "#c08050",
    videoId: "E08Bc02tDIM",
    avatar: {
      rotation: 4,
      skin: 4,
      hairStyle: 4,
      hairColor: 3,
      expression: 2,
      intensity: "h",
    },
    roles: ["engineering", "product"],
    capability: "instant",
    timeSaved: "Instant",
    model: "GPT-4o mini",
    connectors: [SLACK, GITHUB, LINEAR],
    slackPreview: [
      {
        role: "user",
        name: "Alex",
        text: "@Zero create issue: pressing ESC in the schedule dialog closes it immediately even with unsaved edits. Should ask for confirmation first. Assign to Lancy.",
      },
      {
        role: "zero",
        name: "Zero",
        text: "Issue created:\n#6260: bug: ESC key closes schedule dialog without confirming\nAssigned to Lancy \u00b7 Priority: Medium",
      },
    ],
    headings: {
      scenario: "Why filing GitHub issues from Slack saves context switching",
      prompt: "How to create GitHub issues from a Slack message",
      steps: "How Zero parses your message and creates a formatted issue",
      nextActions: "Add details, batch file issues, or automate triage",
      integrations: "Required integrations: GitHub and Slack",
      tips: "Best practices for filing bugs via Slack",
    },
    scenario:
      "You just noticed a UX bug during a demo. Instead of opening GitHub, finding the repo, writing a formatted issue, and assigning someone, you describe it in Slack. Zero creates the issue, adds labels, and assigns the right person. You never leave the conversation.",
    promptVariants: [
      {
        label: "Detailed",
        prompt:
          "@Zero create issue: pressing ESC in the schedule dialog closes it immediately even with unsaved edits. Should ask for confirmation first. Assign to Lancy. Label as bug, platform. Priority medium.",
      },
      {
        label: "Quick",
        prompt:
          "@Zero bug: ESC closes schedule dialog without save confirmation. Assign Lancy.",
      },
      {
        label: "Scheduled",
        prompt:
          "@Zero every Friday at 4pm, check #bugs channel for any unresolved bug reports and create GitHub issues for each one.",
      },
    ],
    steps: [
      {
        title: "Zero parses the request",
        description:
          "Zero understands the bug description, identifies the assignee, and infers appropriate labels (bug, platform) and priority from context.",
      },
      {
        title: "Issue created on GitHub",
        description:
          "Zero creates a properly formatted GitHub issue with a clear title, description, labels, and assignment, all from your natural-language Slack message.",
      },
      {
        title: "Confirmation in Slack",
        description:
          "Zero replies in the same thread with the issue number, title, assignee, and a direct link so you can verify without leaving Slack.",
      },
    ],
    nextActions: [
      {
        title: "Add more detail",
        description: "Attach screenshots or steps to reproduce",
        examplePrompt:
          "@Zero add to #6260: steps to reproduce. 1. Open schedule dialog 2. Type something 3. Press ESC. Expected: confirmation dialog.",
      },
      {
        title: "Batch file issues",
        description: "Create multiple issues at once",
        examplePrompt:
          "@Zero create 3 issues from these bugs:\n1. ESC dialog close (Lancy)\n2. Date picker off by one day (James)\n3. Avatar upload fails on Safari (Yuma)",
      },
      {
        title: "Automate triage",
        description: "Auto-create issues from a channel",
        examplePrompt:
          '@Zero watch #bugs, when someone posts a message starting with "bug:", auto-create a GitHub issue and reply with the link.',
      },
    ],
    integrations: [
      {
        connector: GITHUB,
        description:
          "OAuth connection to GitHub. Zero needs read/write access to create and manage issues.",
        required: true,
      },
      {
        connector: SLACK,
        description: "Zero reads your message and replies in the same thread.",
        required: true,
      },
    ],
    tips: [
      "Include the assignee name. Zero matches Slack display names to GitHub usernames.",
      "Mention labels explicitly if you want specific ones, otherwise Zero infers from context.",
      'Works for feature requests too, just say "feature request" instead of "bug".',
    ],
    relatedSlugs: ["sentry-triage", "standup-summary", "kol-cold-outreach"],
  },

  {
    slug: "slack-triage",
    title: "Cut through Slack noise and surface what needs your attention",
    description:
      "Zero scans your unread Slack messages, filters out bots and noise, and shows you only the messages that actually need your action today, sorted by urgency.",
    color: "#7c9885",
    videoId: "XcqnMX1U0xY",
    avatar: {
      rotation: 3,
      skin: 2,
      hairStyle: 2,
      hairColor: 3,
      expression: 1,
      intensity: "m",
    },
    roles: ["everyone"],
    capability: "instant",
    timeSaved: "~10 min saved",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, LINEAR, GOOGLE_CALENDAR],
    slackPreview: [
      {
        role: "user",
        name: "Lancy",
        text: "@Zero scan my unread Slack from the last 12 hours. Filter out bots and noise. Show me only what needs my action today.",
      },
      {
        role: "zero",
        name: "Zero",
        text: "Found 47 unread messages. 5 need your action:\n\n1. @Ethan asked for your design review on PR #6312\n2. @James needs approval on the Stripe migration plan\n3. #support has a P0 from a customer mentioning churn\n4. @Scarlett tagged you in a KOL outreach decision\n5. Sprint review moved to 3pm (was 2pm)",
      },
    ],
    headings: {
      scenario: "Why Slack overload causes missed action items",
      prompt: "How to ask Zero to triage your unread Slack messages",
      steps: "How Zero filters noise and surfaces actionable messages",
      nextActions: "Reply directly, create tasks, or automate daily triage",
      integrations: "Required integrations: Slack",
      tips: "Best practices for Slack message triage",
    },
    scenario:
      "You open Slack after a 2-hour focus block and there are 47 unread messages across 12 channels. Most are bot notifications, automated alerts, and conversations that don't need you. Somewhere in the noise are 3 things that actually need your response. Instead of scrolling through everything, you ask Zero to find what matters.",
    promptVariants: [
      {
        label: "Detailed",
        prompt:
          "@Zero scan my unread Slack messages from the last 12 hours. Filter out bots, automated notifications, and threads I'm not tagged in. Show me only messages that need my action today, sorted by urgency. For each one, tell me who's waiting and what they need.",
      },
      {
        label: "Quick",
        prompt: "@Zero what needs my attention in Slack right now?",
      },
      {
        label: "Scheduled",
        prompt:
          "@Zero every morning at 9am and after lunch at 1pm, scan my unreads and DM me what needs action.",
      },
    ],
    steps: [
      {
        title: "Zero scans your channels",
        description:
          "Zero reads your unread messages across all channels, filtering out bot messages, automated CI/CD alerts, and threads where you're not mentioned or needed.",
      },
      {
        title: "Messages classified by urgency",
        description:
          "Each remaining message is assessed: is someone waiting on you? Is there a deadline? Is it a decision that's blocking others? Zero ranks them by how urgently they need your response.",
      },
      {
        title: "Actionable summary delivered",
        description:
          "Zero DMs you a numbered list of what needs attention, with who's asking, what they need, and a direct link to each thread. Everything else is safely ignored.",
      },
    ],
    nextActions: [
      {
        title: "Reply through Zero",
        description: "Respond without opening each thread",
        examplePrompt:
          '@Zero reply to #1: "Looks good, approved. Ship it." And for #3, create a P0 Linear issue and assign to James.',
      },
      {
        title: "Make it a routine",
        description: "Auto-triage every morning",
        examplePrompt:
          "@Zero every weekday at 9am, scan my unreads from overnight and DM me the action items.",
      },
    ],
    integrations: [
      {
        connector: SLACK,
        description:
          "Zero reads your unread messages and DMs you the triage summary.",
        required: true,
      },
      {
        connector: LINEAR,
        description: "Optional: create tasks directly from triaged messages.",
        required: false,
      },
      {
        connector: GOOGLE_CALENDAR,
        description:
          "Optional: Zero checks your calendar to flag meeting-related messages.",
        required: false,
      },
    ],
    tips: [
      "Tell Zero which channels matter most to you so it can prioritize accordingly.",
      'Ask Zero to learn your noise patterns over time: "always skip messages from @github-bot and @vercel-bot".',
      "Combine with the standup use case: triage first, then generate your standup from the action items.",
    ],
    relatedSlugs: ["standup-summary", "file-bugs-from-slack", "sentry-triage"],
  },

  {
    slug: "employee-onboarding",
    title: "Onboard new teammates with one Slack message",
    description:
      "Tell Zero who's joining and when. It creates their Notion onboarding page, schedules welcome meetings on Google Calendar, posts a Slack intro, and DMs them their first-week agenda.",
    color: "#6b8cae",
    videoId: "2YA7Iff4XHs",
    avatar: {
      rotation: 5,
      skin: 5,
      hairStyle: 2,
      hairColor: 5,
      expression: 5,
      intensity: "m",
    },
    roles: ["ops", "everyone"],
    capability: "multi-tool",
    timeSaved: "~45 min saved",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, NOTION, GOOGLE_CALENDAR, GMAIL],
    slackPreview: [
      {
        role: "user",
        name: "Lancy",
        text: "@Zero onboard Sarah Chen, joining as Product Designer on April 14. Set up everything.",
      },
      {
        role: "zero",
        name: "Zero",
        text: "Onboarding for Sarah Chen is ready:\n\n\u2714 Notion page created from template\n\u2714 Week-1 intro meetings scheduled\n\u2714 30-day check-in on May 14\n\u2714 Welcome posted to #general\n\u2714 DM sent with first-week agenda",
      },
    ],
    headings: {
      scenario: "Why manual onboarding checklists always miss something",
      prompt: "How to automate new hire onboarding with Zero",
      steps: "How Zero sets up Notion, Calendar, and Slack for a new teammate",
      nextActions: "Add access provisioning or customize by role",
      integrations:
        "Required integrations: Slack, Notion, Google Calendar, and Gmail",
      tips: "Best practices for automated employee onboarding",
    },
    scenario:
      "A new teammate starts next Monday. Someone needs to create their onboarding doc, schedule intro meetings with 5 people, post a welcome message, and send them a first-week agenda. It's 45 minutes of coordination that happens the same way every time. You tell Zero once and it handles everything.",
    promptVariants: [
      {
        label: "Detailed",
        prompt:
          "@Zero onboard Sarah Chen joining as Product Designer on April 14. Duplicate the Notion onboarding template, schedule week-1 intro meetings with Ethan, Lancy, James, Yuma, and Scarlett on Google Calendar. Schedule a 30-day check-in. Post a welcome to #general and DM Sarah her first-week agenda.",
      },
      {
        label: "Quick",
        prompt:
          "@Zero onboard Sarah Chen, Product Designer, starting April 14. Full setup.",
      },
      {
        label: "Template",
        prompt:
          '@Zero when someone posts in #new-hires with format "Name / Role / Start Date", auto-run the full onboarding workflow.',
      },
    ],
    steps: [
      {
        title: "Notion onboarding page created",
        description:
          "Zero duplicates your onboarding template in Notion, fills in the new hire's name, role, start date, and manager. Links to relevant docs and team resources.",
      },
      {
        title: "Meetings scheduled",
        description:
          "Zero creates intro meetings with specified teammates on Google Calendar during the first week, plus a 30-day check-in. All calendar invites include context about what to discuss.",
      },
      {
        title: "Slack welcome and DM sent",
        description:
          "Zero posts a welcome message to #general introducing the new hire, then DMs them directly with their first-week agenda, links to their Notion page, and key contacts.",
      },
    ],
    nextActions: [
      {
        title: "Customize by role",
        description: "Different onboarding for different roles",
        examplePrompt:
          "@Zero for engineers, also add a pairing session with the tech lead and link to the architecture docs in the onboarding page.",
      },
      {
        title: "Automate triggers",
        description: "Run onboarding from a channel post",
        examplePrompt:
          '@Zero whenever someone posts in #new-hires with the format "Name / Role / Start Date", run the full onboarding automatically.',
      },
    ],
    integrations: [
      {
        connector: SLACK,
        description: "Zero posts the welcome message and DMs the new hire.",
        required: true,
      },
      {
        connector: NOTION,
        description: "Zero creates the onboarding page from your template.",
        required: true,
      },
      {
        connector: GOOGLE_CALENDAR,
        description: "Zero schedules intro meetings and check-ins.",
        required: true,
      },
      {
        connector: GMAIL,
        description: "Optional, send a welcome email with logistics and links.",
        required: false,
      },
    ],
    tips: [
      "Create a Notion onboarding template first. Zero duplicates it and fills in the details.",
      "List the people who should have intro meetings. Zero handles the calendar coordination.",
      "Works for contractors and interns too, just adjust the template and meeting list.",
    ],
    relatedSlugs: ["slack-triage", "standup-summary", "file-bugs-from-slack"],
  },

  {
    slug: "build-with-v0",
    title: "Turn a Slack idea into an interactive prototype instantly",
    description:
      "When an idea sparks mid-conversation, describe it to Zero. It uses v0 to generate a clickable React prototype and posts the live preview link back in the thread — before the discussion moves on.",
    color: "#7c8cbe",
    avatar: {
      rotation: 3,
      skin: 1,
      hairStyle: 4,
      hairColor: 5,
      expression: 4,
      intensity: "h",
    },
    roles: ["engineering", "product"],
    capability: "instant",
    timeSaved: "Hours → seconds",
    model: "Claude 4 Sonnet",
    connectors: [SLACK, V0],
    slackPreview: [
      {
        role: "user",
        name: "Ethan",
        text: "@Zero prototype this: a command palette that lets users search agents, recent runs, and connectors. Keyboard-navigable, fuzzy search, shows a preview on the right.",
      },
      {
        role: "zero",
        name: "Zero",
        text: "Here's the interactive prototype:\nv0.dev/r/cmd-palette-preview\n\nIncludes fuzzy search across agents, runs, and connectors. Arrow-key navigation. Right-side preview panel updates on hover. Click to open.",
      },
    ],
    headings: {
      scenario: "Why ideas get lost before anyone can see them",
      prompt: "How to turn a Slack idea into a prototype with Zero",
      steps: "How Zero goes from your description to a live, clickable UI",
      nextActions: "Refine, share, or hand off to engineering",
      integrations: "Required integrations: v0",
      tips: "Best practices for rapid idea prototyping with v0",
    },
    scenario:
      "You're in a Slack thread debating how a feature should work. Someone proposes a new UI pattern — a command palette, a settings panel, a multi-step wizard. Words aren't landing. Sketching on a whiteboard isn't an option. Scheduling a Figma session pushes the decision to next week. You describe the idea to Zero in plain language. It calls v0, generates a fully interactive React prototype, and posts the live preview link right back in the thread — in under a minute. Everyone can click through it before the conversation moves on.",
    promptVariants: [
      {
        label: "New UI idea",
        prompt:
          "@Zero prototype this: a command palette that lets users search agents, recent runs, and connectors. Keyboard-navigable, fuzzy search, shows a preview panel on the right side.",
      },
      {
        label: "From thread context",
        prompt:
          "@Zero based on the flow we just described above, build a quick v0 prototype so the team can see it before we decide.",
      },
      {
        label: "Iterate",
        prompt:
          "@Zero update the prototype — add a filter tab at the top for 'Agents / Runs / Connectors' and highlight the active item in orange. Regenerate.",
      },
    ],
    steps: [
      {
        title: "Describe the idea in plain language",
        description:
          "No spec, no wireframe required. Tell Zero what the UI should do — the components, the interactions, the data it surfaces. Paste a rough sketch description or just riff from the thread.",
      },
      {
        title: "Zero generates the prototype via v0",
        description:
          "Zero translates your description into a structured v0 prompt and calls the v0 API. v0 produces a fully interactive React component — real buttons, real states, real navigation.",
      },
      {
        title: "Live preview link posted in Slack",
        description:
          "Zero posts the v0 preview URL back in the same thread. Teammates can click through the prototype immediately, on any device, without installing anything or checking out code.",
      },
    ],
    nextActions: [
      {
        title: "Refine in the thread",
        description: "Keep iterating without leaving Slack",
        examplePrompt:
          "@Zero update the prototype — the search input should have an icon on the left, and empty state should show recent items instead of nothing.",
      },
      {
        title: "Share for async feedback",
        description: "Post to a broader channel or DM stakeholders",
        examplePrompt:
          "@Zero share the v0 prototype link to #product with the message: 'Quick prototype of the command palette idea — feedback welcome before Thursday.'",
      },
      {
        title: "Hand off to engineering",
        description: "Export the generated code into the repo",
        examplePrompt:
          "@Zero take the v0 prototype code and open a PR in vm0-ai/vm0 under turbo/apps/platform/src/components/CommandPalette.tsx for the team to build on.",
      },
    ],
    integrations: [
      {
        connector: V0,
        description:
          "Zero sends your idea as a generation prompt to v0 and retrieves the interactive prototype URL. Connect your v0 account to enable this.",
        required: true,
      },
      {
        connector: SLACK,
        description:
          "Zero reads your idea from the Slack thread and posts the prototype link back in the same conversation.",
        required: false,
      },
    ],
    tips: [
      "Describe behavior, not just appearance. 'Clicking a row expands details below it' gets a more accurate prototype than 'expandable rows'.",
      "Reference existing UI patterns by name — 'like a VS Code command palette' or 'like Notion's slash menu' — to anchor v0's generation.",
      "Use the iterate prompt immediately after the first result. One round of refinement usually gets you 90% of the way there.",
    ],
    relatedSlugs: [
      "file-bugs-from-slack",
      "standup-summary",
      "employee-onboarding",
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getUseCaseBySlug(slug: string): UseCase | undefined {
  return USE_CASES.find((uc) => {
    return uc.slug === slug;
  });
}
