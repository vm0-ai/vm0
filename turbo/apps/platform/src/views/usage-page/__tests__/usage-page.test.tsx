import { screen, waitFor, within } from "@testing-library/react";
import { zeroUsageInsightContract } from "@vm0/core";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { usageInsightFixture } from "./test-fixtures.ts";

const context = testContext();

describe("/usage page", () => {
  it("shows linked usage details with credit totals", async () => {
    context.mocks.api(zeroUsageInsightContract.get, ({ respond }) => {
      return respond(200, usageInsightFixture);
    });

    detachedSetupPage({ context, path: "/usage" });

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
      expect(screen.getByText("Chat with Agent")).toBeInTheDocument();
    });

    expect(
      queryAllByRoleFast("link").find((el) => {
        return /My Schedule/.test(el.textContent ?? "");
      }),
    ).toBeInTheDocument();
    expect(
      queryAllByRoleFast("link").find((el) => {
        return /Chat with Agent/.test(el.textContent ?? "");
      }),
    ).toBeInTheDocument();
  });
});
