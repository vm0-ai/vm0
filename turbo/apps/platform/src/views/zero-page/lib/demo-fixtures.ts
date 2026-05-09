/**
 * Realistic-feeling fixture data for the four mobile-native list pages
 * when `?demo=1` is on. None of this hits the network — the page swaps
 * the live loadable's data for the fixture array at the render boundary.
 *
 * Backend wiring is out of scope here; engineers will fill in the real
 * server responses for these surfaces later. Until then this gives
 * design / PR review / customer-deck demos a populated UI.
 */

import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import type { ChatThreadListItem } from "@vm0/api-contracts/contracts/chat-threads";
import type { OrgScheduleEntry } from "../../../signals/zero-page/zero-schedule.ts";
import type { ConnectorTypeWithStatus } from "../../../signals/zero-page/settings/connectors.ts";
import { readDemoFlag } from "./demo-flag.ts";

const NOW = (() => {
  return Date.now();
})();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function iso(offset: number): string {
  return new Date(NOW - offset).toISOString();
}

// ---------------------------------------------------------------------------
// /chats — chat thread list
// ---------------------------------------------------------------------------

export function buildDemoChatSessions(): ChatThreadListItem[] {
  const agent = { id: "demo-agent-1", avatarUrl: null };
  return [
    {
      id: "demo-chat-1",
      title: "Tomorrow's design review prep",
      agent,
      createdAt: iso(2 * HOUR),
      updatedAt: iso(8 * MINUTE),
      isRead: false,
      isArchived: false,
      running: false,
      lastMessagePreview:
        "Pulled together the v3 frames + open questions. Want me to flag the ones that need a decision?",
    },
    {
      id: "demo-chat-2",
      title: "Q2 launch copy — landing hero",
      agent,
      createdAt: iso(5 * HOUR),
      updatedAt: iso(45 * MINUTE),
      isRead: true,
      isArchived: false,
      running: false,
      hasDraft: true,
      lastMessagePreview:
        "Drafting three headline variants — short / medium / long-form. First pass uses the new positioning…",
    },
    {
      id: "demo-chat-3",
      title: "Weekly competitor scan",
      agent,
      createdAt: iso(3 * DAY),
      updatedAt: iso(2 * HOUR),
      isRead: true,
      isArchived: false,
      running: true,
      lastMessagePreview: null,
    },
    {
      id: "demo-chat-4",
      title:
        "Untangling the auth middleware migration plan with a much longer title",
      agent,
      createdAt: iso(2 * DAY),
      updatedAt: iso(20 * HOUR),
      isRead: false,
      isArchived: false,
      running: false,
      lastMessagePreview:
        "Looking at the rollout, I'd phase it: shadow-mode first, then dual-write, then cut over.",
    },
    {
      id: "demo-chat-5",
      title: "Onboarding flow copy edits",
      agent,
      createdAt: iso(4 * DAY),
      updatedAt: iso(1 * DAY + 4 * HOUR),
      isRead: true,
      isArchived: false,
      running: false,
      lastMessagePreview:
        "Tightened the welcome screen copy. Want me to also revise the empty states?",
    },
    {
      id: "demo-chat-6",
      title: "Pricing page A/B test results",
      agent,
      createdAt: iso(7 * DAY),
      updatedAt: iso(2 * DAY),
      isRead: true,
      isArchived: false,
      running: false,
      lastMessagePreview:
        "Variant B converted 12% better at p<0.01. Preparing the final write-up with the segment cuts.",
    },
    {
      id: "demo-chat-7",
      title: "Customer call notes — Acme",
      agent,
      createdAt: iso(10 * DAY),
      updatedAt: iso(5 * DAY),
      isRead: true,
      isArchived: false,
      running: false,
      lastMessagePreview:
        "Acme is interested in the enterprise tier. They asked about SSO, SCIM, and audit-log retention.",
    },
    {
      id: "demo-chat-8",
      title: null,
      agent,
      createdAt: iso(14 * DAY),
      updatedAt: iso(12 * DAY),
      isRead: true,
      isArchived: false,
      running: false,
      lastMessagePreview: "Hi! What can I help you draft today?",
    },
  ];
}

// ---------------------------------------------------------------------------
// /agents — teammates list
// ---------------------------------------------------------------------------

export function buildDemoAgents(): TeamComposeItem[] {
  return [
    {
      id: "demo-agent-1",
      displayName: "Zero",
      description: "Your core agent — coordinates everyone else.",
      sound: null,
      avatarUrl: "preset:0",
      headVersionId: "demo-head-1",
      updatedAt: iso(12 * HOUR),
    },
    {
      id: "demo-agent-2",
      displayName: "Lisa",
      description: "Marketing teammate — campaigns, copy, launch comms.",
      sound: null,
      avatarUrl: "preset:1",
      headVersionId: "demo-head-2",
      updatedAt: iso(2 * DAY),
    },
    {
      id: "demo-agent-3",
      displayName: "Tim",
      description: "Engineering teammate — code review, infra, runbook drafts.",
      sound: null,
      avatarUrl: "preset:2",
      headVersionId: "demo-head-3",
      updatedAt: iso(3 * DAY),
    },
    {
      id: "demo-agent-4",
      displayName: "Lancy",
      description: "Customer success teammate — call notes, follow-ups, CRM.",
      sound: null,
      avatarUrl: "preset:3",
      headVersionId: "demo-head-4",
      updatedAt: iso(5 * DAY),
    },
    {
      id: "demo-agent-5",
      displayName: "Sev",
      description: "Research teammate — competitor scans, market briefs.",
      sound: null,
      avatarUrl: "preset:4",
      headVersionId: "demo-head-5",
      updatedAt: iso(7 * DAY),
    },
  ];
}

// ---------------------------------------------------------------------------
// /schedules — scheduled tasks list
// ---------------------------------------------------------------------------

export function buildDemoSchedules(): OrgScheduleEntry[] {
  return [
    {
      id: "demo-sched-1",
      time: "every weekday at 09:00",
      prompt:
        "Pull this week's competitor releases and summarize what changed in <600 words.",
      description: "Daily morning briefing",
      enabled: true,
      name: "demo-sched-1",
      timezone: "America/Los_Angeles",
      intervalSeconds: null,
      agentId: "demo-agent-5",
      displayName: "Sev",
      nextRunAt: iso(-1 * HOUR),
      lastRunAt: iso(23 * HOUR),
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    },
    {
      id: "demo-sched-2",
      time: "every Monday at 10:00",
      prompt: "Draft the weekly OKR digest from the standup notes.",
      description: "Weekly OKR digest",
      enabled: true,
      name: "demo-sched-2",
      timezone: "America/Los_Angeles",
      intervalSeconds: null,
      agentId: "demo-agent-1",
      displayName: "Zero",
      nextRunAt: iso(-3 * DAY),
      lastRunAt: iso(4 * DAY),
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    },
    {
      id: "demo-sched-3",
      time: "every 30 minutes",
      prompt:
        "Tail the Sentry feed for new errors tagged release:prod and post any spike to the channel.",
      description: "Sentry watch",
      enabled: true,
      name: "demo-sched-3",
      timezone: "America/Los_Angeles",
      intervalSeconds: 30 * 60,
      agentId: "demo-agent-3",
      displayName: "Tim",
      nextRunAt: iso(-15 * MINUTE),
      lastRunAt: iso(15 * MINUTE),
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    },
    {
      id: "demo-sched-4",
      time: "every Friday at 16:00",
      prompt:
        "Compile the week's customer call notes into a one-pager with recurring asks.",
      description: "Weekly customer pulse",
      enabled: true,
      name: "demo-sched-4",
      timezone: "America/Los_Angeles",
      intervalSeconds: null,
      agentId: "demo-agent-4",
      displayName: "Lancy",
      nextRunAt: iso(-2 * DAY),
      lastRunAt: iso(5 * DAY),
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    },
    {
      id: "demo-sched-5",
      time: "every weekday at 18:30",
      prompt: "Summarize Slack threads I was @-mentioned in today.",
      description: "Mentions wrap-up",
      enabled: false,
      name: "demo-sched-5",
      timezone: "America/Los_Angeles",
      intervalSeconds: null,
      agentId: "demo-agent-1",
      displayName: "Zero",
      nextRunAt: null,
      lastRunAt: iso(3 * DAY),
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    },
    {
      id: "demo-sched-6",
      time: "every 1st of month at 09:00",
      prompt: "Draft the monthly investor update from last month's metrics.",
      description: "Monthly investor update",
      enabled: true,
      name: "demo-sched-6",
      timezone: "America/Los_Angeles",
      intervalSeconds: null,
      agentId: "demo-agent-2",
      displayName: "Lisa",
      nextRunAt: iso(-15 * DAY),
      lastRunAt: iso(15 * DAY),
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// /connectors — patches the live connector type list to mark a realistic
// subset as `connected: true`. Takes the live array so the static label /
// helpText / category / icon registry stays the source of truth.
// ---------------------------------------------------------------------------

export function patchDemoConnectors(
  live: readonly ConnectorTypeWithStatus[],
): ConnectorTypeWithStatus[] {
  if (!readDemoFlag()) {
    return [...live];
  }
  // Function-scope so the underlying Set isn't a mutable package-scope
  // variable (ccstate/no-package-variable). Construction cost is trivial.
  const connected = new Set([
    "slack",
    "github",
    "google-calendar",
    "google-drive",
    "linear",
    "notion",
  ]);
  return live.map((c) => {
    if (!connected.has(c.type)) {
      return c;
    }
    return {
      ...c,
      connected: true,
      connector: c.connector ?? {
        id: null,
        type: c.type,
        authMethod: "oauth",
        externalId: null,
        externalUsername: c.type === "slack" ? "vm0-ai" : "ming@vm0.ai",
        externalEmail: c.type === "slack" ? null : "ming@vm0.ai",
        oauthScopes: null,
        needsReconnect: false,
        createdAt: iso(7 * DAY),
        updatedAt: iso(2 * HOUR),
      },
      scopeMismatch: false,
      needsReconnect: false,
    };
  });
}
