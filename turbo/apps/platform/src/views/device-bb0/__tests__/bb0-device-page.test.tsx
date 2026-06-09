import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

describe("bb0 device page", () => {
  it("blocks unsupported browsers and gates device code entry", async () => {
    detachedSetupPage({ context, path: "/device/bb0" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "BB0 setup needs Web Bluetooth" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Open this page in a Chromium-based browser/i),
    ).toBeInTheDocument();
  });

  it("disables device code confirmation until Wi-Fi has been sent", async () => {
    context.mocks.browser.webBluetoothSupport();

    detachedSetupPage({ context, path: "/device/bb0" });

    const deviceCodeInput = await screen.findByLabelText("Device code");
    const confirmButton = screen.getByText("Confirm code");

    expect(deviceCodeInput).toBeDisabled();
    expect(confirmButton).toBeDisabled();
  });
});
