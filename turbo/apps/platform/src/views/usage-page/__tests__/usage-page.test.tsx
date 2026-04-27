import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { resetAllMockHandlers } from "../../../mocks/handlers/index.ts";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { zeroUsageInsightContract } from "@vm0/core";
import { usageInsightFixture } from "./test-fixtures.ts";

const context = testContext();

beforeEach(() => {
  resetAllMockHandlers();
});

describe("/_/usage page", () => {
  it("renders the page header and usage insight content", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(200, usageInsightFixture);
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(
        within(
          screen.getByRole("region", { name: "Credits totals" }),
        ).getByText("credits"),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("My Schedule")).toBeInTheDocument();
    });

    const scheduleLink = screen.getAllByRole("link").find((el) => {
      return /My Schedule/.test(el.textContent ?? "");
    });
    expect(scheduleLink).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Chat with Agent")).toBeInTheDocument();
    });

    const chatLink = screen.getAllByRole("link").find((el) => {
      return /Chat with Agent/.test(el.textContent ?? "");
    });
    expect(chatLink).toBeInTheDocument();
  });
});
