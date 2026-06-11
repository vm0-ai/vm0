import type { UsageInsightResponse } from "@vm0/core";

import { isoFromNowMs } from "../../../__tests__/time.ts";

const DAY_MS = 86_400_000;

function bucketTs(daysAgo: number): string {
  return `${isoFromNowMs(-daysAgo * DAY_MS).slice(0, 10)} 00:00:00`;
}

export const usageInsightTodayFixture: Readonly<UsageInsightResponse> = {
  buckets: [
    {
      ts: bucketTs(0),
      series: { chat: 500, slack: 200 },
      tokens: { chat: 1000, slack: 400 },
    },
  ],
  schedules: [
    {
      scheduleId: "s1",
      scheduleName: "My Schedule",
      scheduleDescription: null,
      credits: 300,
      tokens: 600,
    },
  ],
  scheduleOtherCount: 0,
  scheduleOtherCredits: 0,
  chats: [
    {
      threadId: "t1",
      threadTitle: "Chat with Agent",
      credits: 200,
      tokens: 400,
    },
  ],
  chatOtherCount: 0,
  chatOtherCredits: 0,
  emailCredits: 100,
  emailTokens: 200,
  slackCredits: 200,
  slackTokens: 400,
  grandTotalCredits: 1300,
  grandTotalTokens: 2600,
};

export const usageInsightLast7DaysSourceFixture: Readonly<UsageInsightResponse> =
  {
    buckets: [
      {
        ts: bucketTs(6),
        series: { chat: 300, slack: 100, email: 50 },
        tokens: { chat: 600, slack: 200, email: 100 },
      },
      {
        ts: bucketTs(3),
        series: { chat: 500, slack: 200, email: 100 },
        tokens: { chat: 1000, slack: 400, email: 200 },
      },
      {
        ts: bucketTs(0),
        series: { chat: 700, slack: 300, email: 150 },
        tokens: { chat: 1400, slack: 600, email: 300 },
      },
    ],
    schedules: [
      {
        scheduleId: "s1",
        scheduleName: "Daily Digest",
        scheduleDescription: null,
        credits: 800,
        tokens: 1600,
      },
      {
        scheduleId: "s2",
        scheduleName: "Incident Sweep",
        scheduleDescription: "Ops incident sweep",
        credits: 400,
        tokens: 800,
      },
    ],
    scheduleOtherCount: 1,
    scheduleOtherCredits: 200,
    chats: [
      {
        threadId: "t1",
        threadTitle: "Roadmap Review",
        credits: 500,
        tokens: 1000,
      },
      {
        threadId: "t2",
        threadTitle: "Launch Checklist",
        credits: 300,
        tokens: 600,
      },
    ],
    chatOtherCount: 1,
    chatOtherCredits: 200,
    emailCredits: 300,
    emailTokens: 600,
    slackCredits: 600,
    slackTokens: 1200,
    grandTotalCredits: 2400,
    grandTotalTokens: 4800,
  };

export const usageInsightLast7DaysAgentFixture: Readonly<UsageInsightResponse> =
  {
    ...usageInsightLast7DaysSourceFixture,
    buckets: [
      {
        ts: bucketTs(6),
        series: { "Research Agent": 350, "Ops Bot": 100 },
        tokens: { "Research Agent": 700, "Ops Bot": 200 },
      },
      {
        ts: bucketTs(3),
        series: { "Research Agent": 600, "Ops Bot": 200 },
        tokens: { "Research Agent": 1200, "Ops Bot": 400 },
      },
      {
        ts: bucketTs(0),
        series: { "Research Agent": 850, "Ops Bot": 300 },
        tokens: { "Research Agent": 1700, "Ops Bot": 600 },
      },
    ],
  };
