import { screen, waitFor } from "@testing-library/react";
import { bb0DeviceConfirmContract } from "@vm0/api-contracts/contracts/device-token";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

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

  it("connects BB0, sends Wi-Fi, and confirms the device code", async () => {
    context.mocks.browser.bb0Device();
    context.mocks.api(bb0DeviceConfirmContract.confirm, ({ respond }) => {
      return respond(200, { status: "approved" });
    });

    detachedSetupPage({ context, path: "/device/bb0" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Set up BB0" }),
      ).toBeInTheDocument();
    });

    click(buttonByText("Connect BB0"));

    await waitFor(() => {
      expect(
        screen.getByText("Connected · Zero-Buddy-Test"),
      ).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Wi-Fi SSID"), "Zero-Lab");
    await fill(screen.getByLabelText("Password"), "correct horse battery");
    click(buttonByText("Send Wi-Fi"));

    await waitFor(() => {
      expect(screen.getAllByText("Wi-Fi sent")).not.toHaveLength(0);
    });
    expect(screen.getByLabelText("Device code")).not.toBeDisabled();

    await fill(screen.getByLabelText("Device code"), "abcd2345");
    click(buttonByText("Confirm code"));

    await waitFor(() => {
      expect(screen.getByText("Confirmed")).toBeInTheDocument();
      expect(screen.getByText("Code confirmed")).toBeInTheDocument();
      expect(
        screen.getByText(
          "All done! BB0 will check in over Wi-Fi and start working shortly.",
        ),
      ).toBeInTheDocument();
    });
  });
});
