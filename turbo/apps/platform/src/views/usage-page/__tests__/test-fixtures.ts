import type { UsageInsightResponse } from "@vm0/core";

export const usageInsightFixture: Readonly<UsageInsightResponse> = {
  buckets: [
    {
      ts: "2026-04-13 00:00:00",
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
