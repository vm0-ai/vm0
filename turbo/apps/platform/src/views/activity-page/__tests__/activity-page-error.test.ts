import { screen, waitFor } from "@testing-library/react";
import { logsListContract } from "@vm0/api-contracts/contracts/logs";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

describe("activity page error", () => {
  it("shows a recoverable error when activity data cannot load", async () => {
    context.mocks.data.composesList([]);
    context.mocks.api(logsListContract.list, ({ respond }) => {
      return respond(403, {
        error: { message: "Internal Server Error", code: "INTERNAL" },
      });
    });

    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(
      screen.getByText("Failed to load activity data"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Something went wrong. Please try again later."),
    ).toBeInTheDocument();
  });
});
