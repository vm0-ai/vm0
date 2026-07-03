import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

const agentId = "c0000000-0000-4000-a000-000000000001";

describe("zero ideation page", () => {
  it("filters use cases and starts an agent chat from a selected idea", async () => {
    detachedSetupPage({
      context,
      path: `/agents/${agentId}/ideas`,
    });

    await waitFor(() => {
      expect(screen.getAllByText("Ideas & Use Cases")[0]).toBeInTheDocument();
    });
    expect(screen.getByText("Daily standup report")).toBeInTheDocument();

    await fill(screen.getByLabelText("Search use cases"), "RevenueCat");

    await waitFor(() => {
      expect(
        screen.getByText("RevenueCat subscription digest"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();

    click(screen.getByText("RevenueCat subscription digest"));

    const composer = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    expect(composer).toHaveValue(
      "Set up a daily RevenueCat digest that tracks new subscriptions, renewals, and cancellations in Google Sheets and alerts on Slack for churn spikes",
    );
  });
});
