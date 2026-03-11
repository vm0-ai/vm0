/**
 * Mock data for Zero demo pages (chat, schedule).
 * TODO: Remove once these pages are connected to real API data.
 */

interface MockJobItem {
  id: string;
  agentName: string;
  title: string;
  description: string;
  scope: "personal" | "team";
}

export const ZERO_TEAM_JOBS: readonly Readonly<MockJobItem>[] = [
  {
    id: "1",
    agentName: "Minion 1",
    title: "Daily Digest",
    description: "Get a daily summary of your team's important updates.",
    scope: "team",
  },
  {
    id: "2",
    agentName: "Minion 2",
    title: "GitHub Issue Triage",
    description: "Automatically categorize and prioritize new GitHub issues.",
    scope: "personal",
  },
  {
    id: "3",
    agentName: "Minion 3",
    title: "Weekly Report",
    description: "Receive a weekly summary of your team's achievements.",
    scope: "team",
  },
  {
    id: "4",
    agentName: "Minion 4",
    title: "Customer Feedback Digest",
    description: "Compile and analyze customer feedback from multiple sources.",
    scope: "personal",
  },
];
