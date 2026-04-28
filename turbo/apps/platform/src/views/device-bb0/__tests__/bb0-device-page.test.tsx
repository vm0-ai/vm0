import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

describe("bb0 device page", () => {
  it("blocks browsers without supported Web Bluetooth", async () => {
    detachedSetupPage({
      context,
      path: "/device/bb0",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "bb0 setup needs Web Bluetooth" }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Open this page in a Chromium-based browser/i),
    ).toBeInTheDocument();
  });
});
