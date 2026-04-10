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

const INTERCOM: ConnectorRef = {
  id: "intercom",
  label: "Intercom",
  icon: "/assets/connectors/intercom.svg",
};

const AXIOM: ConnectorRef = {
  id: "axiom",
  label: "Axiom",
  icon: "/assets/connectors/axiom.svg",
};

const GOOGLE_SHEETS: ConnectorRef = {
  id: "google-sheets",
  label: "Google Sheets",
  icon: "/assets/connectors/google-sheet.svg",
};

const HUBSPOT: ConnectorRef = {
  id: "hubspot",
  label: "HubSpot",
  icon: "/assets/connectors/hubspot.svg",
};

const VERCEL: ConnectorRef = {
  id: "vercel",
  label: "Vercel",
  icon: "/assets/connectors/vercel.svg",
};

const FIGMA: ConnectorRef = {
  id: "figma",
  label: "Figma",
  icon: "/assets/connectors/figma.svg",
};

const AIRTABLE: ConnectorRef = {
  id: "airtable",
  label: "Airtable",
  icon: "/assets/connectors/airtable.svg",
};

const DROPBOX: ConnectorRef = {
  id: "dropbox",
  label: "Dropbox",
  icon: "/assets/connectors/dropbox.svg",
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
    relatedSlugs: [
      "file-bugs-from-slack",
      "customer-feedback-triage",
      "slack-triage",
    ],
  },

  {
    slug: "file-bugs-from-slack",
    title: "File bugs from Slack without switching context",
    description:
      "Describe the issue in plain language. Zero creates a formatted GitHub issue, labels it, and assigns the right person.",
    color: "#c08050",
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
    slug: "customer-feedback-triage",
    title: "Triage customer feedback into categorized Linear issues",
    description:
      "Zero reads feedback from Gmail and Slack, categorizes by theme (bug, feature request, churn signal), creates Linear issues for urgent items, and posts a summary.",
    color: "#a07cb5",
    avatar: {
      rotation: 1,
      skin: 3,
      hairStyle: 4,
      hairColor: 1,
      expression: 2,
      intensity: "d",
    },
    roles: ["product", "ops"],
    capability: "multi-tool",
    timeSaved: "~30 min saved",
    model: "Claude 4 Sonnet",
    connectors: [GMAIL, INTERCOM, LINEAR, SLACK],
    slackPreview: [
      {
        role: "user",
        name: "Alex",
        text: "@Zero pull the last 7 days of customer feedback from Gmail and #support channel. Categorize by theme, create P0 Linear issues for churn signals.",
      },
      {
        role: "zero",
        name: "Zero",
        text: "Feedback report: last 7 days:\n\n12 messages analyzed\n\u2022 3 bug reports (2 P0 issues created)\n\u2022 5 feature requests\n\u2022 2 churn signals (Linear issues created)\n\u2022 2 positive feedback",
      },
    ],
    headings: {
      scenario: "Why customer feedback gets lost across inboxes and channels",
      prompt: "How to ask Zero to triage customer feedback",
      steps: "How Zero categorizes feedback and creates actionable issues",
      nextActions: "Track trends over time or automate weekly",
      integrations: "Required integrations: Gmail, Linear, and Slack",
      tips: "Best practices for automated feedback triage",
    },
    scenario:
      "Customer feedback is scattered across Gmail, Slack, and support channels. Some messages are bugs, some are feature requests, and some are churn signals that need immediate attention. You ask Zero to pull it all together, categorize it, and create issues for anything urgent.",
    promptVariants: [
      {
        label: "Detailed",
        prompt:
          "@Zero pull the last 7 days of customer feedback from Gmail and #support channel. Categorize each by theme: bug, feature request, churn signal, or positive feedback. Create P0 Linear issues for any churn signals. Post a summary with top complaints and feature requests.",
      },
      {
        label: "Quick",
        prompt:
          "@Zero summarize last week's customer feedback from Gmail and #support. Flag churn risks.",
      },
      {
        label: "Scheduled",
        prompt:
          "@Zero every Monday at 10am, run the customer feedback triage and post results to #product.",
      },
    ],
    steps: [
      {
        title: "Zero scans Gmail and Slack",
        description:
          "Zero reads recent customer messages from Gmail threads and the #support Slack channel, filtering out internal conversations and automated notifications.",
      },
      {
        title: "Feedback categorized",
        description:
          "Each message is classified: bug report, feature request, churn signal, or positive feedback. Zero assesses severity and urgency for each.",
      },
      {
        title: "Issues created and summary posted",
        description:
          "Urgent items (churn signals, critical bugs) become Linear issues with context. Zero posts a summary with themes, counts, and top requests to Slack.",
      },
    ],
    nextActions: [
      {
        title: "Track trends",
        description: "See how feedback themes change over time",
        examplePrompt:
          "@Zero compare this week's feedback themes to last week. What's trending up?",
      },
      {
        title: "Automate weekly",
        description: "Run the triage every Monday",
        examplePrompt:
          "@Zero every Monday at 10am, run customer feedback triage and post to #product.",
      },
    ],
    integrations: [
      {
        connector: GMAIL,
        description:
          "Zero reads customer feedback from your Gmail inbox threads.",
        required: true,
      },
      {
        connector: LINEAR,
        description:
          "Zero creates issues for bugs and churn signals with proper labels.",
        required: true,
      },
      {
        connector: SLACK,
        description: "Zero reads #support and posts the summary.",
        required: true,
      },
    ],
    tips: [
      "Specify which Gmail labels or threads contain customer feedback to reduce noise.",
      'Define what counts as a churn signal for your business. "mentions cancellation, competitor, or frustration".',
      "Combine with Sentry triage for a complete view of customer-facing issues.",
    ],
    relatedSlugs: ["sentry-triage", "file-bugs-from-slack", "standup-summary"],
  },

  {
    slug: "pr-auto-review",
    title: "Auto-review PRs with smart reviewer assignment",
    description:
      "When a PR is opened, Zero analyzes the diff, detects the code area, assigns the right reviewer from CODEOWNERS, and posts a structured review comment.",
    color: "#8b7355",
    avatar: {
      rotation: 2,
      skin: 4,
      hairStyle: 3,
      hairColor: 2,
      expression: 4,
      intensity: "h",
    },
    roles: ["engineering"],
    capability: "multi-tool",
    timeSaved: "~10 min saved",
    model: "Claude 4 Sonnet",
    connectors: [GITHUB, VERCEL, LINEAR, SLACK],
    slackPreview: [
      {
        role: "user",
        name: "James",
        text: "@Zero when a PR is opened on vm0/vm0, analyze the diff, assign the right reviewer, and post a summary comment on the PR.",
      },
      {
        role: "zero",
        name: "Zero",
        text: "Done. I'll watch for new PRs on vm0/vm0.\n\nFor each PR I'll:\n1. Detect code area (frontend/backend/infra)\n2. Assign reviewer from CODEOWNERS\n3. Post structured review comment",
      },
    ],
    headings: {
      scenario: "Why PR reviews get delayed without smart assignment",
      prompt: "How to set up automated PR review with Zero",
      steps: "How Zero analyzes diffs and assigns reviewers",
      nextActions: "Add code quality checks or integrate with Linear",
      integrations: "Required integrations: GitHub, Linear, and Slack",
      tips: "Best practices for automated PR review workflows",
    },
    scenario:
      "A PR sits for 2 days because nobody knows who should review it. The author picked someone random, and that person is busy with something else. Meanwhile, the right reviewer, the person who owns that code area, doesn't even know the PR exists.",
    promptVariants: [
      {
        label: "Detailed",
        prompt:
          "@Zero when a PR is opened on vm0/vm0, analyze the changed files to detect the code area (frontend, backend, infra, etc). Find the right reviewer from CODEOWNERS or git blame. Post a structured review comment covering: summary, key changes, potential issues. Then DM the reviewer on Slack.",
      },
      {
        label: "Quick",
        prompt:
          "@Zero auto-assign reviewers and post review comments on new PRs in vm0/vm0.",
      },
      {
        label: "Scheduled",
        prompt:
          "@Zero every morning at 9am, find open PRs without reviewers and assign the right person.",
      },
    ],
    steps: [
      {
        title: "Zero analyzes the diff",
        description:
          "Zero reads the PR diff, identifies which code areas are affected (frontend, backend, infrastructure, tests), and understands the scope of changes.",
      },
      {
        title: "Right reviewer assigned",
        description:
          "Using CODEOWNERS rules and git blame history, Zero identifies who should review this PR and requests their review on GitHub.",
      },
      {
        title: "Review comment posted",
        description:
          "Zero posts a structured comment on the PR, summary of changes, potential issues to watch, and any breaking changes detected.",
      },
    ],
    nextActions: [
      {
        title: "Add review reminders",
        description: "Nudge reviewers who haven't responded",
        examplePrompt:
          "@Zero if a PR has been waiting for review for 24h, DM the reviewer on Slack.",
      },
      {
        title: "Link to Linear",
        description: "Auto-link PRs to their Linear issues",
        examplePrompt:
          "@Zero when a PR mentions a Linear issue ID, link them and update the issue status to In Review.",
      },
    ],
    integrations: [
      {
        connector: GITHUB,
        description:
          "Zero reads PR diffs, CODEOWNERS, and posts review comments.",
        required: true,
      },
      {
        connector: SLACK,
        description: "Zero notifies reviewers via DM when assigned.",
        required: false,
      },
      {
        connector: LINEAR,
        description: "Optional, link PRs to Linear issues and update status.",
        required: false,
      },
    ],
    tips: [
      "Make sure your CODEOWNERS file is up to date. Zero uses it as the primary source for reviewer assignment.",
      'Ask Zero to skip draft PRs. "only review PRs marked as ready for review".',
      "Works best with consistent PR conventions, branch naming, commit messages, and labels.",
    ],
    relatedSlugs: ["sentry-triage", "file-bugs-from-slack", "standup-summary"],
  },

  {
    slug: "integration-error-forensics",
    title: "Diagnose API integration failures without opening 5 tabs",
    description:
      "Give Zero an error message or connector name. It reads the relevant code in GitHub, cross-references request logs in Axiom, and explains exactly what broke, why, and what to fix.",
    color: "#7a8fa8",
    avatar: {
      rotation: 3,
      skin: 2,
      hairStyle: 1,
      hairColor: 3,
      expression: 4,
      intensity: "h",
    },
    roles: ["engineering"],
    capability: "multi-tool",
    timeSaved: "~30 min saved",
    model: "Claude 4 Sonnet",
    connectors: [GITHUB, AXIOM, SLACK],
    slackPreview: [
      {
        role: "user",
        name: "Lancy",
        text: "@Zero we're still getting 'Plain upsertTenant failed | forbidden' errors. I thought we fixed the PLAIN_API_KEY scope. Why is it still failing?",
      },
      {
        role: "zero",
        name: "Zero",
        text: "Root cause found. The fix in api/connectors/plain.ts only re-scopes tokens on reconnect. Axiom shows 3 errors in the last hour — all from accounts connected before the deploy.\n\nFix: force a token refresh for pre-deploy tenants.",
      },
    ],
    headings: {
      scenario: "Why integration errors are hard to debug without context",
      prompt: "How to ask Zero to diagnose a connector or API failure",
      steps: "How Zero correlates code, logs, and error traces to find root cause",
      nextActions: "Create a fix PR, open an issue, or set up an error alert",
      integrations: "Required integrations: GitHub, Axiom, and Slack",
      tips: "Best practices for AI-assisted integration debugging",
    },
    scenario:
      "You get an error report: a connector is failing in production, and you've already shipped what you thought was a fix. You ask Zero to investigate. It reads the relevant code, checks Axiom for real error patterns, and comes back with a precise explanation — not a guess, but a root-cause analysis based on what's actually happening in your logs.",
    promptVariants: [
      {
        label: "Detailed",
        prompt:
          "@Zero investigate the Plain connector 'forbidden' errors. Check the connector code in GitHub, look at Axiom logs for the past 2 hours, and explain why the fix we shipped didn't resolve it. Tell me exactly what needs to change.",
      },
      {
        label: "Quick",
        prompt:
          "@Zero why is the Plain connector still failing? Check GitHub and Axiom logs.",
      },
      {
        label: "Alert",
        prompt:
          "@Zero whenever Axiom shows more than 5 errors from the same connector in an hour, post a diagnostic summary to #dev.",
      },
    ],
    steps: [
      {
        title: "Zero reads the relevant code",
        description:
          "Zero searches the GitHub repository for the connector or integration code related to the error, reads the implementation, and understands how the integration is supposed to work.",
      },
      {
        title: "Zero checks Axiom logs",
        description:
          "Zero queries Axiom for recent error events matching the connector or endpoint, identifies patterns — timing, affected accounts, error codes — and cross-references them with the code.",
      },
      {
        title: "Root cause explained",
        description:
          "Zero delivers a plain-language explanation of why the error is happening, which code path is responsible, and what the precise fix should be — including the file and line if relevant.",
      },
    ],
    nextActions: [
      {
        title: "Create a fix PR",
        description: "Turn the diagnosis into a pull request",
        examplePrompt:
          "@Zero based on the analysis, create a PR that forces token refresh for pre-deploy tenants. Assign to me.",
      },
      {
        title: "Open a tracked issue",
        description: "File a GitHub issue from the findings",
        examplePrompt:
          "@Zero create a GitHub issue documenting this root cause, the affected accounts, and the fix approach. Label as bug, priority high.",
      },
      {
        title: "Set up an error alert",
        description: "Get notified when similar errors spike",
        examplePrompt:
          "@Zero set up a daily Axiom check: if any connector shows more than 10 errors in 24h, post a summary to #dev.",
      },
    ],
    integrations: [
      {
        connector: GITHUB,
        description:
          "Zero reads connector and integration code to understand implementation context.",
        required: true,
      },
      {
        connector: AXIOM,
        description:
          "Zero queries logs for error patterns, timing, and affected accounts.",
        required: true,
      },
      {
        connector: SLACK,
        description:
          "Zero delivers the diagnostic report in the thread where you asked.",
        required: true,
      },
    ],
    tips: [
      "Give Zero the exact error message or connector name. The more specific, the faster the diagnosis.",
      "Ask Zero to compare log patterns before and after a deploy to isolate regression causes.",
      "Combine with Sentry triage for a full picture: Sentry for stack traces, Axiom for request-level context.",
    ],
    relatedSlugs: ["sentry-triage", "file-bugs-from-slack", "pr-auto-review"],
  },

  {
    slug: "content-performance-digest",
    title: "Turn last week's social posts into next week's content strategy",
    description:
      "Zero pulls your published posts from Notion, fetches engagement data from X, scores which content themes resonated, and logs the findings to Google Sheets for trend tracking.",
    color: "#c4936a",
    avatar: {
      rotation: 2,
      skin: 5,
      hairStyle: 3,
      hairColor: 1,
      expression: 2,
      intensity: "m",
    },
    roles: ["product"],
    capability: "scheduled",
    timeSaved: "~20 min saved",
    model: "Claude 4 Sonnet",
    connectors: [X_TWITTER, NOTION, GOOGLE_SHEETS],
    slackPreview: [
      {
        role: "user",
        name: "Scarlett",
        text: "@Zero every Monday, pull last week's X posts from the Notion content queue, get their engagement data, and log top performers to the Content Performance sheet.",
      },
      {
        role: "zero",
        name: "Zero",
        text: "Content Performance — Week of Apr 7:\n• 5 posts analyzed\n• Top performer: 'AI agents vs assistants' thread — 847 impressions, 4.2% engagement\n• Underperformed: product screenshots — avg 1.1%\n• Recommendation: double down on opinion posts\n\u2705 Logged to Google Sheets",
      },
    ],
    headings: {
      scenario: "Why content strategy guesswork costs growth",
      prompt: "How to ask Zero to analyze your social content performance",
      steps: "How Zero connects Notion, X, and Google Sheets to close the content loop",
      nextActions: "Refine your content calendar or A/B test formats",
      integrations: "Required integrations: X, Notion, and Google Sheets",
      tips: "Best practices for data-driven social content strategy",
    },
    scenario:
      "Your team publishes content every week, but nobody knows what's actually working. Some posts get traction, others get ignored, and the team keeps producing similar content without knowing why. Zero connects your Notion content queue to X's engagement data and logs the results weekly, so next week's strategy is based on evidence, not instinct.",
    promptVariants: [
      {
        label: "Detailed",
        prompt:
          "@Zero every Monday at 9am, pull last week's published posts from the Notion Content Queue database. Fetch their X engagement metrics (impressions, likes, replies, reposts). Score each by engagement rate. Group by content theme. Log results to the Content Performance Google Sheet and post the top 3 and bottom 3 to #marketing.",
      },
      {
        label: "Quick",
        prompt:
          "@Zero which X posts from last week performed best? Check the Notion content queue.",
      },
      {
        label: "On-demand",
        prompt:
          "@Zero analyze the last 30 days of X posts from our Notion queue. What themes consistently outperform? What should we cut?",
      },
    ],
    steps: [
      {
        title: "Zero reads your content queue",
        description:
          "Zero connects to Notion and reads your published posts database, pulling titles, publish dates, content themes, and post URLs from last week.",
      },
      {
        title: "Engagement data fetched from X",
        description:
          "For each post URL, Zero fetches impressions, likes, reposts, replies, and profile clicks from X, then calculates engagement rate and ranks posts by performance.",
      },
      {
        title: "Findings logged and posted",
        description:
          "Zero appends a new row to your Google Sheets performance tracker with this week's data, and posts a summary to Slack highlighting what worked and what themes to try next week.",
      },
    ],
    nextActions: [
      {
        title: "Inform next week's calendar",
        description: "Ask Zero to suggest content based on top performers",
        examplePrompt:
          "@Zero based on last week's performance data, suggest 5 content ideas for this week that match the top-performing themes.",
      },
      {
        title: "Identify best posting times",
        description: "Find when your audience is most engaged",
        examplePrompt:
          "@Zero look at the last 4 weeks of data in the Google Sheet. Is there a correlation between posting time and engagement rate?",
      },
    ],
    integrations: [
      {
        connector: X_TWITTER,
        description:
          "Zero reads engagement metrics for your published posts.",
        required: true,
      },
      {
        connector: NOTION,
        description:
          "Zero reads your published content from the Notion content queue database.",
        required: true,
      },
      {
        connector: GOOGLE_SHEETS,
        description:
          "Zero logs weekly performance data for trend tracking over time.",
        required: true,
      },
    ],
    tips: [
      "Keep your Notion content queue consistent: a URL field and a Theme tag are all Zero needs to get started.",
      "Ask Zero to track relative performance, not just raw numbers — a 5% engagement rate means something different at 500 vs 50,000 followers.",
      "Run this for at least 8 weeks before drawing conclusions. Short data windows can be misleading.",
    ],
    relatedSlugs: ["kol-cold-outreach", "standup-summary", "employee-onboarding"],
  },

  {
    slug: "compliance-deadline-tracker",
    title: "Never miss a tax filing or compliance deadline again",
    description:
      "Zero scans your compliance schedule in Google Sheets and flags anything due in the next 7 days, posting structured reminders to Slack with owner, action steps, and due date.",
    color: "#7a9e8a",
    avatar: {
      rotation: 5,
      skin: 3,
      hairStyle: 4,
      hairColor: 5,
      expression: 1,
      intensity: "m",
    },
    roles: ["ops"],
    capability: "scheduled",
    timeSaved: "~15 min saved",
    model: "Claude 4 Sonnet",
    connectors: [GOOGLE_CALENDAR, GOOGLE_SHEETS, SLACK],
    slackPreview: [
      {
        role: "user",
        name: "Lancy",
        text: "@Zero every Monday, check our Compliance Deadlines sheet. Post anything due in the next 7 days to #all-vm0 with owner and action steps.",
      },
      {
        role: "zero",
        name: "Zero",
        text: "\u26a0\ufe0f Compliance Reminder \u2014 week of Apr 10:\n\n\u2022 Monthly tax filing (\u5185\u8d44\u516c\u53f8) \u2014 due Apr 15 \u00b7 Owner: Finance\n\u2022 Payroll run \u2014 due Apr 14 \u00b7 Owner: HR\n\u2022 Google OAuth consent renewal \u2014 due Apr 18 \u00b7 Owner: Engineering\n\n3 items due this week.",
      },
    ],
    headings: {
      scenario: "Why compliance deadlines fall through the cracks",
      prompt: "How to ask Zero to track and remind you of compliance deadlines",
      steps: "How Zero scans your schedule and delivers structured reminders",
      nextActions: "Mark items complete, escalate overdue items, or add new deadlines",
      integrations: "Required integrations: Google Sheets, Google Calendar, and Slack",
      tips: "Best practices for automated compliance tracking",
    },
    scenario:
      "Monthly tax filings, payroll runs, OAuth consent renewals, contractor agreement renewals — your ops calendar has dozens of recurring deadlines that are easy to miss when everyone is heads-down on product. Someone finds out too late, usually right before or after the due date. Zero checks the schedule every week and posts what's coming up, so nothing gets missed.",
    promptVariants: [
      {
        label: "Detailed",
        prompt:
          "@Zero every Monday at 9am, check the Compliance Deadlines sheet. For anything due in the next 7 days, post to #all-vm0 with: deadline name, due date, owner, and required action steps. If anything is already overdue, flag it as urgent.",
      },
      {
        label: "Quick",
        prompt:
          "@Zero what compliance deadlines are coming up this week? Check the deadlines sheet.",
      },
      {
        label: "On-demand",
        prompt:
          "@Zero check the compliance calendar and tell me everything due in April, grouped by owner.",
      },
    ],
    steps: [
      {
        title: "Zero reads the compliance schedule",
        description:
          "Zero connects to your Google Sheets compliance tracker and reads all upcoming deadlines, including due date, owner, action required, and current status.",
      },
      {
        title: "Deadlines filtered by urgency",
        description:
          "Zero identifies items due in the next 7 days and flags any that are already overdue. Items are sorted by due date and grouped by owner for easy action.",
      },
      {
        title: "Reminder posted to Slack",
        description:
          "Zero posts a structured reminder to the designated Slack channel with each item's name, due date, owner, and action steps — no calendar-hunting required.",
      },
    ],
    nextActions: [
      {
        title: "Mark items complete",
        description: "Update the sheet when a filing is done",
        examplePrompt:
          "@Zero mark the April monthly tax filing as complete in the Compliance Deadlines sheet.",
      },
      {
        title: "Escalate overdue items",
        description: "Alert owners when something is past due",
        examplePrompt:
          "@Zero if any compliance item is more than 2 days overdue, DM the owner directly on Slack.",
      },
      {
        title: "Add new deadlines",
        description: "Keep the schedule current",
        examplePrompt:
          "@Zero add a new row to the Compliance Deadlines sheet: 'Annual business license renewal', due June 30, owner Finance.",
      },
    ],
    integrations: [
      {
        connector: GOOGLE_SHEETS,
        description:
          "Zero reads your compliance deadlines from a shared spreadsheet.",
        required: true,
      },
      {
        connector: GOOGLE_CALENDAR,
        description:
          "Optional, Zero also checks for compliance-tagged calendar events to catch deadlines not in the sheet.",
        required: false,
      },
      {
        connector: SLACK,
        description:
          "Zero posts the weekly reminder to the team channel and DMs overdue alerts to owners.",
        required: true,
      },
    ],
    tips: [
      "Keep a standard Google Sheet with columns: Deadline Name, Due Date, Owner, Action Required, Status. Zero works with any layout but consistency helps.",
      "Tag compliance events in Google Calendar too — Zero can cross-reference both sources to catch anything missing from the sheet.",
      "Set the reminder for Monday mornings so the team can plan the week around what's coming up.",
    ],
    relatedSlugs: ["employee-onboarding", "standup-summary", "slack-triage"],
  },

  {
    slug: "activation-health-check",
    title: "Spot stuck new users before they churn",
    description:
      "Zero checks HubSpot for new signups, cross-references Intercom for activation activity, and flags users who haven't connected their first integration — giving your team a head start on proactive outreach.",
    color: "#9b7ab8",
    avatar: {
      rotation: 1,
      skin: 4,
      hairStyle: 5,
      hairColor: 2,
      expression: 3,
      intensity: "d",
    },
    roles: ["ops", "product"],
    capability: "multi-tool",
    timeSaved: "~25 min saved",
    model: "Claude 4 Sonnet",
    connectors: [HUBSPOT, INTERCOM, SLACK],
    slackPreview: [
      {
        role: "user",
        name: "Alex",
        text: "@Zero check new signups from the last 48h in HubSpot. Flag anyone in Intercom who hasn't connected a connector yet. Post at-risk users to #product.",
      },
      {
        role: "zero",
        name: "Zero",
        text: "New User Health Check \u2014 Apr 10:\n\n5 new signups in the last 48h\n\ud83d\udd34 At risk (2) \u2014 no connector connected:\n\u2022 user@acme.com (signed up 38h ago)\n\u2022 dev@startup.io (signed up 44h ago)\n\u2705 Activated (3) \u2014 connected Slack + GitHub\n\nRecommend: send onboarding nudge to at-risk users.",
      },
    ],
    headings: {
      scenario: "Why new users go dark in the first 48 hours",
      prompt: "How to ask Zero to identify stuck new users",
      steps: "How Zero correlates HubSpot signups with Intercom activation data",
      nextActions: "Send a nudge, open a support conversation, or track activation trends",
      integrations: "Required integrations: HubSpot, Intercom, and Slack",
      tips: "Best practices for proactive new user activation",
    },
    scenario:
      "A new user signs up but never connects their first integration. Nobody notices for a week — by which point they've already lost interest. Zero checks HubSpot for recent signups, looks at Intercom to see who's stuck at zero activations, and flags the at-risk users daily so your team can reach out before they churn.",
    promptVariants: [
      {
        label: "Detailed",
        prompt:
          "@Zero check HubSpot for signups in the last 48 hours. For each new user, check Intercom to see if they've connected at least one integration. Flag anyone who hasn't. Post to #product with their email, signup time, and current activation status. Suggest a personalized nudge for each at-risk user.",
      },
      {
        label: "Quick",
        prompt:
          "@Zero which new users from the last 2 days haven't activated yet? Check HubSpot and Intercom.",
      },
      {
        label: "Scheduled",
        prompt:
          "@Zero every morning at 10am, run the new user activation check and post at-risk users to #product.",
      },
    ],
    steps: [
      {
        title: "Zero pulls new signups from HubSpot",
        description:
          "Zero queries HubSpot for contacts created in the past 48 hours, extracting their email, signup time, and plan type.",
      },
      {
        title: "Activation status checked in Intercom",
        description:
          "For each new user, Zero checks Intercom to see their session activity and whether they've completed the first activation step — connecting an integration. Users are classified as activated or at-risk.",
      },
      {
        title: "At-risk users posted to Slack",
        description:
          "Zero posts a structured list of at-risk users to the designated channel, with enough context for your team to reach out personally: signup time, company, and what they haven't done yet.",
      },
    ],
    nextActions: [
      {
        title: "Send a personal nudge",
        description: "Have Zero draft an outreach email for stuck users",
        examplePrompt:
          "@Zero draft a short, friendly email to user@acme.com who signed up 38 hours ago but hasn't connected anything. Keep it under 80 words. Save as Gmail draft.",
      },
      {
        title: "Open an Intercom conversation",
        description: "Reach out directly inside the product",
        examplePrompt:
          "@Zero send a proactive Intercom message to the 2 at-risk users from today's check. Use the standard activation nudge template.",
      },
      {
        title: "Track activation trends",
        description: "Monitor your activation rate over time",
        examplePrompt:
          "@Zero compare this week's new user activation rate to last week's. Are we improving?",
      },
    ],
    integrations: [
      {
        connector: HUBSPOT,
        description:
          "Zero queries new contacts and their signup details from your HubSpot CRM.",
        required: true,
      },
      {
        connector: INTERCOM,
        description:
          "Zero checks session activity and activation events for each new user.",
        required: true,
      },
      {
        connector: SLACK,
        description:
          "Zero posts the at-risk user list to your product or growth channel.",
        required: true,
      },
    ],
    tips: [
      "Define your activation threshold clearly. 'Connected at least one integration' is easier to check than vague engagement metrics.",
      "Run this daily, not weekly. Users decide in the first 48 hours whether to invest time in a product.",
      "Combine with customer feedback triage — if stuck users also sent a support message, that context helps your outreach.",
    ],
    relatedSlugs: [
      "customer-feedback-triage",
      "employee-onboarding",
      "slack-triage",
    ],
  },

  {
    slug: "deployment-changelog",
    title: "Auto-generate a changelog when you deploy to production",
    description:
      "After a Vercel deploy, Zero fetches all merged PRs since the last release, writes a human-readable changelog, posts it to Slack, and updates your Notion changelog page.",
    color: "#5a7d6e",
    avatar: {
      rotation: 4,
      skin: 1,
      hairStyle: 5,
      hairColor: 4,
      expression: 3,
      intensity: "d",
    },
    roles: ["engineering"],
    capability: "multi-tool",
    timeSaved: "~15 min saved",
    model: "Claude 4 Sonnet",
    connectors: [VERCEL, GITHUB, SLACK, NOTION],
    slackPreview: [
      {
        role: "user",
        name: "James",
        text: "@Zero when a production deploy completes on Vercel, write a changelog from merged PRs and post to #product-updates.",
      },
      {
        role: "zero",
        name: "Zero",
        text: "Done. Watching Vercel deploys.\n\nAfter each production deploy I'll:\n1. Fetch merged PRs since last deploy\n2. Write human-readable changelog\n3. Post to #product-updates\n4. Update Notion changelog page",
      },
    ],
    headings: {
      scenario: "Why deployments need visible changelogs",
      prompt: "How to automate changelog generation after deploys",
      steps: "How Zero turns merged PRs into a readable changelog",
      nextActions: "Notify customers or tag specific teams per change area",
      integrations: "Required integrations: Vercel, GitHub, Slack, and Notion",
      tips: "Best practices for automated deployment changelogs",
    },
    scenario:
      'You just deployed to production. The team asks "what shipped?" and nobody has a clean answer. Someone has to dig through GitHub, find the merged PRs, and write a summary. With Zero, the changelog writes itself the moment the deploy completes.',
    promptVariants: [
      {
        label: "Detailed",
        prompt:
          "@Zero when a production deploy completes on Vercel, fetch all merged PRs since the last deploy. Group changes by area (features, fixes, improvements). Write a human-readable changelog with PR links. Post to #product-updates and update the Notion changelog page.",
      },
      {
        label: "Quick",
        prompt:
          "@Zero on Vercel deploy, write changelog from PRs and post to #product-updates.",
      },
      {
        label: "On-demand",
        prompt:
          "@Zero write a changelog for everything merged since the last Vercel production deploy.",
      },
    ],
    steps: [
      {
        title: "Deploy detected",
        description:
          "Zero watches for Vercel production deployment events. When a deploy completes, it identifies the commit range since the last release.",
      },
      {
        title: "PRs analyzed",
        description:
          "Zero fetches all merged PRs in the commit range from GitHub, reads their titles and descriptions, and groups them by type: new features, bug fixes, improvements, and infrastructure changes.",
      },
      {
        title: "Changelog published",
        description:
          "Zero writes a clean, non-technical changelog suitable for the whole team, then posts it to Slack and appends it to your Notion changelog page with the deploy date and version.",
      },
    ],
    nextActions: [
      {
        title: "Tag teams per area",
        description: "Notify specific teams about changes in their area",
        examplePrompt:
          "@Zero in the changelog, @mention the frontend team for UI changes and the backend team for API changes.",
      },
      {
        title: "Customer-facing notes",
        description: "Generate external release notes",
        examplePrompt:
          "@Zero also write a customer-facing version of the changelog, no internal details, focus on user-visible improvements.",
      },
    ],
    integrations: [
      {
        connector: VERCEL,
        description:
          "Zero detects production deployments and identifies the commit range.",
        required: true,
      },
      {
        connector: GITHUB,
        description:
          "Zero reads merged PRs and their descriptions from your repository.",
        required: true,
      },
      {
        connector: SLACK,
        description: "Zero posts the changelog to your team channel.",
        required: true,
      },
      {
        connector: NOTION,
        description:
          "Optional, append the changelog to a Notion page for historical tracking.",
        required: false,
      },
    ],
    tips: [
      'Use clear PR titles. Zero uses them as changelog entries, so "fix: resolve Stripe webhook retry" works better than "fix bug".',
      "Ask Zero to skip certain PR labels. \"exclude PRs labeled 'internal' or 'chore' from the changelog\".",
      "Combine with the PR auto-review use case for a fully automated code-to-deploy pipeline.",
    ],
    relatedSlugs: ["pr-auto-review", "sentry-triage", "file-bugs-from-slack"],
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
