import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockUsageInsight } from "../../../mocks/handlers/api-usage-insight.ts";
import { resetAllMockHandlers } from "../../../mocks/handlers/index.ts";

const context = testContext();

beforeEach(() => {
  resetAllMockHandlers();
});

describe("/_/usage page", () => {
  it("renders the page header and usage insight content", async () => {
    setMockUsageInsight({
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
          credits: 300,
          tokens: 600,
        },
      ],
      chats: [
        {
          threadId: "t1",
          threadTitle: "Chat with Agent",
          credits: 200,
          tokens: 400,
        },
      ],
      emailCredits: 100,
      emailTokens: 200,
      slackCredits: 200,
      slackTokens: 400,
      grandTotalCredits: 1300,
      grandTotalTokens: 2600,
    });

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Usage Insights")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("My Schedule")).toBeInTheDocument();
    });
    expect(screen.getByText("Chat with Agent")).toBeInTheDocument();
  });
});
