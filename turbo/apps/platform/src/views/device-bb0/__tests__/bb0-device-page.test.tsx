import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function defineWindowProperty(
  target: object,
  property: string,
  value: unknown,
): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  Object.defineProperty(target, property, {
    configurable: true,
    value,
  });
  return descriptor;
}

function restoreWindowProperty(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }
  Reflect.deleteProperty(target, property);
}

function mockSupportedWebBluetooth(signal: AbortSignal): void {
  const secureContextDescriptor = defineWindowProperty(
    window,
    "isSecureContext",
    true,
  );
  const userAgentDataDescriptor = defineWindowProperty(
    navigator,
    "userAgentData",
    { brands: [{ brand: "Chromium", version: "120" }] },
  );
  const bluetoothDescriptor = defineWindowProperty(navigator, "bluetooth", {
    requestDevice: () => {
      return Promise.reject(new Error("Bluetooth selection is not used."));
    },
  });

  signal.addEventListener("abort", () => {
    restoreWindowProperty(window, "isSecureContext", secureContextDescriptor);
    restoreWindowProperty(navigator, "userAgentData", userAgentDataDescriptor);
    restoreWindowProperty(navigator, "bluetooth", bluetoothDescriptor);
  });
}

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

  it("allows entering a device code before Wi-Fi is sent from the page", async () => {
    mockSupportedWebBluetooth(context.signal);

    detachedSetupPage({
      context,
      path: "/device/bb0",
    });

    const deviceCodeInput = await screen.findByLabelText("Device code");
    const confirmButton = screen.getByText("Confirm code");

    expect(deviceCodeInput).toBeEnabled();
    expect(confirmButton).toBeDisabled();

    await fill(deviceCodeInput, "abcd2345");

    expect(deviceCodeInput).toHaveValue("ABCD-2345");
    expect(confirmButton).toBeEnabled();
  });
});
