import { command, computed, state } from "ccstate";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export interface AgentUsage {
  agentName: string;
  agentId: string | null;
  runs: number;
  credits: number;
}

export interface ServiceUsage {
  name: string;
  domain: string;
  calls: number;
  /** Which agents used this service */
  agentNames: string[];
}

export interface PermissionEntry {
  label: string;
  allowed: number;
  denied: number;
  /** Which agents triggered this permission */
  agentNames: string[];
}

export interface TopTask {
  name: string;
  count: number;
}

export interface MemberCredits {
  name: string;
  credits: number;
}

/** A single day's insight snapshot */
export interface DayInsight {
  date: string; // ISO date, e.g. "2026-04-03"
  agents: AgentUsage[];
  creditsUsed: number;
  creditBalance: number;
  teamUsage: MemberCredits[];
  topTask: TopTask | null;
  services: ServiceUsage[];
  permissions: PermissionEntry[];
}

export interface NetworkInsightsData {
  days: DayInsight[];
  totalCredits: number;
  totalRuns: number;
}

// ---------------------------------------------------------------------------
// UI state signals
// ---------------------------------------------------------------------------

/** Page-level date range filter */
const internalDateRange$ = state<string>("last30");

export const insightsDateRange$ = computed((get) => {
  return get(internalDateRange$);
});

export const setInsightsDateRange$ = command(({ set }, range: string) => {
  set(internalDateRange$, range);
});

/** Hover state — which agent is hovered and on which date */
const internalHoveredAgent$ = state<{
  date: string;
  name: string;
} | null>(null);

export const insightsHoveredAgent$ = computed((get) => {
  return get(internalHoveredAgent$);
});

export const setInsightsHoveredAgent$ = command(
  ({ set }, value: { date: string; name: string } | null) => {
    set(internalHoveredAgent$, value);
  },
);

/** Calendar popover state */
const internalCalendarOpen$ = state(false);

export const insightsCalendarOpen$ = computed((get) => {
  return get(internalCalendarOpen$);
});

export const setInsightsCalendarOpen$ = command(({ set }, open: boolean) => {
  set(internalCalendarOpen$, open);
});

const internalCalendarYear$ = state(2026);
const internalCalendarMonth$ = state(3); // April = month 3

export const insightsCalendarYear$ = computed((get) => {
  return get(internalCalendarYear$);
});

export const insightsCalendarMonth$ = computed((get) => {
  return get(internalCalendarMonth$);
});

export const setInsightsCalendarYear$ = command(({ set }, year: number) => {
  set(internalCalendarYear$, year);
});

export const setInsightsCalendarMonth$ = command(({ set }, month: number) => {
  set(internalCalendarMonth$, month);
});

// ---------------------------------------------------------------------------
// Mock data (extracted from real run logs — replace with API call later)
// ---------------------------------------------------------------------------

function buildDay20260403(): DayInsight {
  return {
    date: "2026-04-03",
    agents: [
      {
        agentName: "Design & Marketing report",
        agentId: "16ef8895-3c9d-4d8d-9d36-4cdd811b1822",
        runs: 1,
        credits: 18,
      },
      {
        agentName: "vm0 Social Media Researcher",
        agentId: "10cf9358-f3f3-4120-b992-f57b147d284b",
        runs: 3,
        credits: 22,
      },
      {
        agentName: "Marketing Monitor",
        agentId: "a7d14dde-f10c-4233-ba47-4860094e9a57",
        runs: 2,
        credits: 8,
      },
    ],
    creditsUsed: 48,
    creditBalance: 9552,
    teamUsage: [
      { name: "Ming", credits: 28 },
      { name: "Ethan", credits: 12 },
      { name: "Lisa", credits: 8 },
    ],
    topTask: { name: "Read Slack messages", count: 24 },
    services: [
      {
        name: "Slack",
        domain: "slack.com",
        calls: 24,
        agentNames: [
          "Design & Marketing report",
          "vm0 Social Media Researcher",
          "Marketing Monitor",
        ],
      },
      {
        name: "Linear",
        domain: "linear.app",
        calls: 18,
        agentNames: ["Design & Marketing report", "Marketing Monitor"],
      },
      {
        name: "Gmail",
        domain: "gmail.com",
        calls: 12,
        agentNames: ["Design & Marketing report"],
      },
      {
        name: "Google Calendar",
        domain: "calendar.google.com",
        calls: 8,
        agentNames: ["Design & Marketing report"],
      },
      {
        name: "X (Twitter)",
        domain: "x.com",
        calls: 6,
        agentNames: ["vm0 Social Media Researcher"],
      },
      {
        name: "Google Sheets",
        domain: "docs.google.com",
        calls: 4,
        agentNames: ["Marketing Monitor"],
      },
    ],
    permissions: [
      {
        label: "Read Slack messages",
        allowed: 24,
        denied: 0,
        agentNames: [
          "Design & Marketing report",
          "vm0 Social Media Researcher",
          "Marketing Monitor",
        ],
      },
      {
        label: "Send Slack messages",
        allowed: 3,
        denied: 0,
        agentNames: ["Marketing Monitor"],
      },
      {
        label: "Read Linear issues",
        allowed: 18,
        denied: 0,
        agentNames: ["Design & Marketing report", "Marketing Monitor"],
      },
      {
        label: "Read emails",
        allowed: 12,
        denied: 0,
        agentNames: ["Design & Marketing report"],
      },
      {
        label: "Read calendar events",
        allowed: 8,
        denied: 0,
        agentNames: ["Design & Marketing report"],
      },
      {
        label: "Read X posts & metrics",
        allowed: 6,
        denied: 0,
        agentNames: ["vm0 Social Media Researcher"],
      },
      {
        label: "Read Google Sheets",
        allowed: 4,
        denied: 0,
        agentNames: ["Marketing Monitor"],
      },
    ],
  };
}

function buildDay20260402Services(): ServiceUsage[] {
  return [
    {
      name: "X (Twitter)",
      domain: "x.com",
      calls: 31,
      agentNames: ["vm0 Social Media Researcher", "Design News"],
    },
    {
      name: "Slack",
      domain: "slack.com",
      calls: 22,
      agentNames: ["Design & Marketing report", "vm0 Social Media Researcher"],
    },
    {
      name: "Linear",
      domain: "linear.app",
      calls: 15,
      agentNames: ["Design & Marketing report"],
    },
    {
      name: "Gmail",
      domain: "gmail.com",
      calls: 10,
      agentNames: ["Design & Marketing report"],
    },
    {
      name: "Google Calendar",
      domain: "calendar.google.com",
      calls: 6,
      agentNames: ["Design & Marketing report"],
    },
    {
      name: "Google Sheets",
      domain: "docs.google.com",
      calls: 3,
      agentNames: ["Design & Marketing report"],
    },
    {
      name: "Hacker News",
      domain: "news.ycombinator.com",
      calls: 8,
      agentNames: ["HN Karma Builder"],
    },
  ];
}

function buildDay20260402Permissions(): PermissionEntry[] {
  return [
    {
      label: "Search X posts",
      allowed: 31,
      denied: 0,
      agentNames: ["vm0 Social Media Researcher", "Design News"],
    },
    {
      label: "Post to X",
      allowed: 4,
      denied: 2,
      agentNames: ["vm0 Social Media Researcher"],
    },
    {
      label: "Read Slack messages",
      allowed: 22,
      denied: 0,
      agentNames: ["Design & Marketing report", "vm0 Social Media Researcher"],
    },
    {
      label: "Send Slack messages",
      allowed: 5,
      denied: 0,
      agentNames: ["vm0 Social Media Researcher"],
    },
    {
      label: "Read Linear issues",
      allowed: 15,
      denied: 0,
      agentNames: ["Design & Marketing report"],
    },
    {
      label: "Create Linear issues",
      allowed: 0,
      denied: 3,
      agentNames: ["Design & Marketing report"],
    },
    {
      label: "Read emails",
      allowed: 10,
      denied: 0,
      agentNames: ["Design & Marketing report"],
    },
    {
      label: "Read calendar events",
      allowed: 6,
      denied: 0,
      agentNames: ["Design & Marketing report"],
    },
    {
      label: "Read Google Sheets",
      allowed: 3,
      denied: 0,
      agentNames: ["Design & Marketing report"],
    },
    {
      label: "Read Hacker News",
      allowed: 8,
      denied: 0,
      agentNames: ["HN Karma Builder"],
    },
  ];
}

function buildDay20260402(): DayInsight {
  return {
    date: "2026-04-02",
    agents: [
      {
        agentName: "Design & Marketing report",
        agentId: "16ef8895-3c9d-4d8d-9d36-4cdd811b1822",
        runs: 1,
        credits: 15,
      },
      {
        agentName: "vm0 Social Media Researcher",
        agentId: "10cf9358-f3f3-4120-b992-f57b147d284b",
        runs: 4,
        credits: 32,
      },
      {
        agentName: "HN Karma Builder",
        agentId: "53f412bd-0f40-4deb-9696-97996cf6294a",
        runs: 2,
        credits: 16,
      },
      {
        agentName: "Design News",
        agentId: "3a7792b2-1357-44fa-9f36-4a735394b170",
        runs: 1,
        credits: 9,
      },
    ],
    creditsUsed: 72,
    creditBalance: 9600,
    teamUsage: [
      { name: "Ming", credits: 45 },
      { name: "Ethan", credits: 18 },
      { name: "Lisa", credits: 9 },
    ],
    topTask: { name: "Search X posts", count: 31 },
    services: buildDay20260402Services(),
    permissions: buildDay20260402Permissions(),
  };
}

function buildDay20260401Services(): ServiceUsage[] {
  return [
    {
      name: "X (Twitter)",
      domain: "x.com",
      calls: 42,
      agentNames: ["vm0 Social Media Researcher", "AI News Consultant"],
    },
    {
      name: "Slack",
      domain: "slack.com",
      calls: 28,
      agentNames: ["Design & Marketing report", "vm0 Social Media Researcher"],
    },
    {
      name: "Linear",
      domain: "linear.app",
      calls: 14,
      agentNames: ["Design & Marketing report"],
    },
    {
      name: "Gmail",
      domain: "gmail.com",
      calls: 11,
      agentNames: ["Design & Marketing report"],
    },
    {
      name: "Google Calendar",
      domain: "calendar.google.com",
      calls: 7,
      agentNames: ["Design & Marketing report"],
    },
    {
      name: "Google Sheets",
      domain: "docs.google.com",
      calls: 5,
      agentNames: ["Design & Marketing report"],
    },
    {
      name: "WebSearch",
      domain: "web",
      calls: 16,
      agentNames: ["Researcher", "AI News Consultant"],
    },
  ];
}

function buildDay20260401Permissions(): PermissionEntry[] {
  return [
    {
      label: "Search X posts",
      allowed: 42,
      denied: 0,
      agentNames: ["vm0 Social Media Researcher", "AI News Consultant"],
    },
    {
      label: "Post to X",
      allowed: 8,
      denied: 0,
      agentNames: ["vm0 Social Media Researcher"],
    },
    {
      label: "Read Slack messages",
      allowed: 28,
      denied: 0,
      agentNames: ["Design & Marketing report", "vm0 Social Media Researcher"],
    },
    {
      label: "Send Slack messages",
      allowed: 6,
      denied: 0,
      agentNames: ["vm0 Social Media Researcher"],
    },
    {
      label: "Read Linear issues",
      allowed: 14,
      denied: 0,
      agentNames: ["Design & Marketing report"],
    },
    {
      label: "Read emails",
      allowed: 11,
      denied: 0,
      agentNames: ["Design & Marketing report"],
    },
    {
      label: "Read calendar events",
      allowed: 7,
      denied: 0,
      agentNames: ["Design & Marketing report"],
    },
    {
      label: "Read Google Sheets",
      allowed: 5,
      denied: 0,
      agentNames: ["Design & Marketing report"],
    },
    {
      label: "Web search",
      allowed: 16,
      denied: 0,
      agentNames: ["Researcher", "AI News Consultant"],
    },
    {
      label: "Delete Slack messages",
      allowed: 0,
      denied: 1,
      agentNames: ["vm0 Social Media Researcher"],
    },
  ];
}

function buildDay20260401(): DayInsight {
  return {
    date: "2026-04-01",
    agents: [
      {
        agentName: "Design & Marketing report",
        agentId: "16ef8895-3c9d-4d8d-9d36-4cdd811b1822",
        runs: 1,
        credits: 20,
      },
      {
        agentName: "vm0 Social Media Researcher",
        agentId: "10cf9358-f3f3-4120-b992-f57b147d284b",
        runs: 5,
        credits: 45,
      },
      {
        agentName: "AI News Consultant",
        agentId: "3b588110-e494-4c40-ab93-b0a12fbbbc8d",
        runs: 2,
        credits: 22,
      },
      {
        agentName: "Researcher",
        agentId: "c6d6f3a3-6088-42fc-9afb-9e68fba1d734",
        runs: 1,
        credits: 8,
      },
    ],
    creditsUsed: 95,
    creditBalance: 9672,
    teamUsage: [
      { name: "Ming", credits: 52 },
      { name: "Ethan", credits: 30 },
      { name: "Lisa", credits: 13 },
    ],
    topTask: { name: "Search X posts", count: 42 },
    services: buildDay20260401Services(),
    permissions: buildDay20260401Permissions(),
  };
}

function buildDay20260331(): DayInsight {
  return {
    date: "2026-03-31",
    agents: [
      {
        agentName: "Design & Marketing report",
        agentId: "16ef8895-3c9d-4d8d-9d36-4cdd811b1822",
        runs: 1,
        credits: 15,
      },
      {
        agentName: "vm0 Social Media Researcher",
        agentId: "10cf9358-f3f3-4120-b992-f57b147d284b",
        runs: 3,
        credits: 20,
      },
    ],
    creditsUsed: 35,
    creditBalance: 9767,
    teamUsage: [
      { name: "Ming", credits: 20 },
      { name: "Ethan", credits: 10 },
      { name: "Lisa", credits: 5 },
    ],
    topTask: { name: "Read Slack messages", count: 19 },
    services: [
      {
        name: "Slack",
        domain: "slack.com",
        calls: 19,
        agentNames: [
          "Design & Marketing report",
          "vm0 Social Media Researcher",
        ],
      },
      {
        name: "Linear",
        domain: "linear.app",
        calls: 12,
        agentNames: ["Design & Marketing report"],
      },
      {
        name: "X (Twitter)",
        domain: "x.com",
        calls: 15,
        agentNames: ["vm0 Social Media Researcher"],
      },
      {
        name: "Gmail",
        domain: "gmail.com",
        calls: 8,
        agentNames: ["Design & Marketing report"],
      },
      {
        name: "Google Calendar",
        domain: "calendar.google.com",
        calls: 5,
        agentNames: ["Design & Marketing report"],
      },
      {
        name: "Google Sheets",
        domain: "docs.google.com",
        calls: 2,
        agentNames: ["Design & Marketing report"],
      },
    ],
    permissions: [
      {
        label: "Read Slack messages",
        allowed: 19,
        denied: 0,
        agentNames: [
          "Design & Marketing report",
          "vm0 Social Media Researcher",
        ],
      },
      {
        label: "Send Slack messages",
        allowed: 4,
        denied: 0,
        agentNames: ["vm0 Social Media Researcher"],
      },
      {
        label: "Search X posts",
        allowed: 15,
        denied: 0,
        agentNames: ["vm0 Social Media Researcher"],
      },
      {
        label: "Read Linear issues",
        allowed: 12,
        denied: 0,
        agentNames: ["Design & Marketing report"],
      },
      {
        label: "Read emails",
        allowed: 8,
        denied: 0,
        agentNames: ["Design & Marketing report"],
      },
      {
        label: "Read calendar events",
        allowed: 5,
        denied: 0,
        agentNames: ["Design & Marketing report"],
      },
      {
        label: "Read Google Sheets",
        allowed: 2,
        denied: 0,
        agentNames: ["Design & Marketing report"],
      },
    ],
  };
}

function buildDay20260330Services(): ServiceUsage[] {
  return [
    {
      name: "X (Twitter)",
      domain: "x.com",
      calls: 56,
      agentNames: ["vm0 Social Media Researcher", "Marketing Monitor"],
    },
    {
      name: "Slack",
      domain: "slack.com",
      calls: 32,
      agentNames: [
        "Design & Marketing report",
        "vm0 Social Media Researcher",
        "Marketing Monitor",
      ],
    },
    {
      name: "Linear",
      domain: "linear.app",
      calls: 20,
      agentNames: ["Design & Marketing report", "Marketing Monitor"],
    },
    {
      name: "Gmail",
      domain: "gmail.com",
      calls: 14,
      agentNames: ["Design & Marketing report"],
    },
    {
      name: "Google Calendar",
      domain: "calendar.google.com",
      calls: 9,
      agentNames: ["Design & Marketing report"],
    },
    {
      name: "Google Sheets",
      domain: "docs.google.com",
      calls: 6,
      agentNames: ["Design & Marketing report", "Marketing Monitor"],
    },
    {
      name: "GitHub",
      domain: "github.com",
      calls: 11,
      agentNames: ["Code Security Auditor"],
    },
    {
      name: "Hacker News",
      domain: "news.ycombinator.com",
      calls: 10,
      agentNames: ["HN Karma Builder"],
    },
  ];
}

function buildDay20260330Permissions(): PermissionEntry[] {
  return [
    {
      label: "Search X posts",
      allowed: 56,
      denied: 0,
      agentNames: ["vm0 Social Media Researcher", "Marketing Monitor"],
    },
    {
      label: "Post to X",
      allowed: 12,
      denied: 0,
      agentNames: ["vm0 Social Media Researcher"],
    },
    {
      label: "Read Slack messages",
      allowed: 32,
      denied: 0,
      agentNames: [
        "Design & Marketing report",
        "vm0 Social Media Researcher",
        "Marketing Monitor",
      ],
    },
    {
      label: "Send Slack messages",
      allowed: 8,
      denied: 0,
      agentNames: ["vm0 Social Media Researcher", "Marketing Monitor"],
    },
    {
      label: "Read Linear issues",
      allowed: 20,
      denied: 0,
      agentNames: ["Design & Marketing report", "Marketing Monitor"],
    },
    {
      label: "Read emails",
      allowed: 14,
      denied: 0,
      agentNames: ["Design & Marketing report"],
    },
    {
      label: "Read calendar events",
      allowed: 9,
      denied: 0,
      agentNames: ["Design & Marketing report"],
    },
    {
      label: "Read Google Sheets",
      allowed: 6,
      denied: 0,
      agentNames: ["Design & Marketing report", "Marketing Monitor"],
    },
    {
      label: "Read GitHub repos",
      allowed: 11,
      denied: 0,
      agentNames: ["Code Security Auditor"],
    },
    {
      label: "Push to GitHub",
      allowed: 0,
      denied: 4,
      agentNames: ["Code Security Auditor"],
    },
    {
      label: "Read Hacker News",
      allowed: 10,
      denied: 0,
      agentNames: ["HN Karma Builder"],
    },
    {
      label: "Post to Hacker News",
      allowed: 3,
      denied: 1,
      agentNames: ["HN Karma Builder"],
    },
  ];
}

function buildDay20260330(): DayInsight {
  return {
    date: "2026-03-30",
    agents: [
      {
        agentName: "Design & Marketing report",
        agentId: "16ef8895-3c9d-4d8d-9d36-4cdd811b1822",
        runs: 1,
        credits: 18,
      },
      {
        agentName: "vm0 Social Media Researcher",
        agentId: "10cf9358-f3f3-4120-b992-f57b147d284b",
        runs: 6,
        credits: 55,
      },
      {
        agentName: "Code Security Auditor",
        agentId: "edadea4b-131d-465d-b792-1d5ccb12f87d",
        runs: 1,
        credits: 12,
      },
      {
        agentName: "Marketing Monitor",
        agentId: "a7d14dde-f10c-4233-ba47-4860094e9a57",
        runs: 3,
        credits: 25,
      },
      {
        agentName: "HN Karma Builder",
        agentId: "53f412bd-0f40-4deb-9696-97996cf6294a",
        runs: 2,
        credits: 18,
      },
    ],
    creditsUsed: 128,
    creditBalance: 9802,
    teamUsage: [
      { name: "Ming", credits: 68 },
      { name: "Ethan", credits: 35 },
      { name: "Lisa", credits: 25 },
    ],
    topTask: { name: "Search X posts", count: 56 },
    services: buildDay20260330Services(),
    permissions: buildDay20260330Permissions(),
  };
}

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------

export const networkInsightsData$ = computed((_get): NetworkInsightsData => {
  const days = [
    buildDay20260403(),
    buildDay20260402(),
    buildDay20260401(),
    buildDay20260331(),
    buildDay20260330(),
  ];
  return {
    days,
    totalCredits: days.reduce((s, d) => {
      return s + d.creditsUsed;
    }, 0),
    totalRuns: days.reduce((s, d) => {
      return (
        s +
        d.agents.reduce((a, ag) => {
          return a + ag.runs;
        }, 0)
      );
    }, 0),
  };
});
