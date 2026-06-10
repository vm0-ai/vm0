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

  it("keeps Bluetooth selection failures visible and retryable", async () => {
    context.mocks.browser.webBluetoothSupport();

    detachedSetupPage({ context, path: "/device/bb0" });

    await waitFor(() => {
      expect(buttonByText("Connect BB0")).not.toBeDisabled();
    });
    click(buttonByText("Connect BB0"));

    await waitFor(() => {
      expect(
        screen.getByText("Bluetooth selection is not used."),
      ).toBeInTheDocument();
      expect(buttonByText("Connect BB0")).not.toBeDisabled();
      expect(screen.getByLabelText("Wi-Fi SSID")).toBeDisabled();
    });
  });

  it("disconnects and reconnects BB0 from the setup page", async () => {
    context.mocks.browser.bb0Device();

    detachedSetupPage({ context, path: "/device/bb0" });

    await waitFor(() => {
      expect(buttonByText("Connect BB0")).not.toBeDisabled();
    });
    click(buttonByText("Connect BB0"));

    await waitFor(() => {
      expect(
        screen.getByText("Connected · Zero-Buddy-Test"),
      ).toBeInTheDocument();
    });

    click(buttonByText("Disconnect"));

    await waitFor(() => {
      expect(
        screen.queryByText("Connected · Zero-Buddy-Test"),
      ).not.toBeInTheDocument();
      expect(buttonByText("Connect BB0")).not.toBeDisabled();
      expect(screen.getByLabelText("Wi-Fi SSID")).toBeDisabled();
    });

    click(buttonByText("Connect BB0"));

    await waitFor(() => {
      expect(
        screen.getByText("Connected · Zero-Buddy-Test"),
      ).toBeInTheDocument();
    });
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

  it("keeps code confirmation retryable after the device code is rejected", async () => {
    let confirmAttempts = 0;
    context.mocks.browser.bb0Device();
    context.mocks.api(bb0DeviceConfirmContract.confirm, ({ respond }) => {
      confirmAttempts += 1;
      if (confirmAttempts === 1) {
        return respond(404, {
          error: {
            message: "Device code not found or expired",
            code: "NOT_FOUND",
          },
        });
      }
      return respond(200, { status: "approved" });
    });

    detachedSetupPage({ context, path: "/device/bb0" });

    await waitFor(() => {
      expect(buttonByText("Connect BB0")).not.toBeDisabled();
    });
    click(buttonByText("Connect BB0"));
    await waitFor(() => {
      expect(
        screen.getByText("Connected · Zero-Buddy-Test"),
      ).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Wi-Fi SSID"), "Zero-Lab");
    click(buttonByText("Send Wi-Fi"));
    await waitFor(() => {
      expect(screen.getAllByText("Wi-Fi sent")).not.toHaveLength(0);
    });

    await fill(screen.getByLabelText("Device code"), "abcd2345");
    click(buttonByText("Confirm code"));

    await waitFor(() => {
      expect(
        screen.getByText("Device code not found or expired"),
      ).toBeInTheDocument();
      expect(buttonByText("Confirm code")).not.toBeDisabled();
    });

    click(buttonByText("Confirm code"));

    await waitFor(() => {
      expect(screen.getByText("Confirmed")).toBeInTheDocument();
      expect(screen.getByText("Code confirmed")).toBeInTheDocument();
    });
  });

  it("resets visible setup progress from the footer action", async () => {
    context.mocks.browser.bb0Device();

    detachedSetupPage({ context, path: "/device/bb0" });

    await waitFor(() => {
      expect(buttonByText("Connect BB0")).not.toBeDisabled();
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

    click(screen.getByText("reset this page"));

    await waitFor(() => {
      expect(
        screen.queryByText("Connected · Zero-Buddy-Test"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Wi-Fi sent")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Wi-Fi SSID")).toHaveValue("");
      expect(screen.getByLabelText("Password")).toHaveValue("");
      expect(screen.getByLabelText("Device code")).toBeDisabled();
      expect(buttonByText("Connect BB0")).not.toBeDisabled();
    });
  });
});
