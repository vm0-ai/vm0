import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";

const context = testContext();

describe("banking connect return page", () => {
  it("renders a completed Finicity return and removes provider parameters", async () => {
    detachedSetupPage({
      context,
      path: "/banking/connect/return?reason=complete&code=200&reportData=null",
      user: null,
      session: null,
    });

    const heading = await screen.findByRole("heading", {
      name: "Bank account connected",
    });
    expect(heading).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Bank account" }),
    ).toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").find((button) => {
        return button.textContent?.trim() === "Close window";
      }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(pathname()).toBe("/banking/connect/return/success");
    });
    expect(search()).toBe("");
  });

  it("renders an incomplete Finicity return as a failure", async () => {
    detachedSetupPage({
      context,
      path: "/banking/connect/return?reason=cancel&code=0",
      user: null,
      session: null,
    });

    await expect(
      screen.findByRole("heading", {
        name: "Couldn’t connect Bank account",
      }),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(pathname()).toBe("/banking/connect/return/error");
    });
    expect(search()).toBe("");
  });
});
