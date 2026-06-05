import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";

const context = testContext();

const SCHEDULE_ID = "f0000001-0000-4000-a000-000000000001";
const CHAT_THREAD_ID = "d0000000-0000-4000-a000-000000000001";

function mockAPIs(
  schedules = [
    createMockScheduleResponse({
      displayName: "Zero",
      description: "Daily morning briefing",
    }),
  ],
) {
  setMockSchedules(schedules);
}

describe("zero schedule detail page", () => {
  it("should render schedule detail when navigating to /schedules/:id", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    // The detail page shows the description as the page title (appears in
    // breadcrumb, header, and sidebar, so use getAllByText).
    await waitFor(() => {
      expect(
        screen.getAllByText("Daily morning briefing")[0],
      ).toBeInTheDocument();
    });

    // Should NOT show the not-found screen
    expect(screen.queryByText("Schedule not found")).not.toBeInTheDocument();
  });

  it("should show not-found when schedule id does not match any schedule", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/schedules/f0000001-0000-4000-a000-999999999999",
    });

    await waitFor(() => {
      expect(screen.getByText("Schedule not found")).toBeInTheDocument();
    });
  });

  it("links the breadcrumb back to the chat thread for chat-mode schedules", async () => {
    mockAPIs([
      createMockScheduleResponse({
        displayName: "Zero",
        name: SCHEDULE_ID,
        chatThreadId: CHAT_THREAD_ID,
        description:
          "Daily morning briefing with a title that needs to be shortened",
      }),
    ]);
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    const chatThreadLink = await waitFor(() => {
      const link = queryAllByRoleFast("link").find((element) => {
        return element.textContent?.includes("Chat thread");
      });
      expect(link).toBeDefined();
      return link!;
    });

    expect(chatThreadLink).toHaveAttribute("href", `/chats/${CHAT_THREAD_ID}`);
    expect(
      screen.getAllByText("Daily morning briefing with a…")[0],
    ).toBeInTheDocument();
  });
});
