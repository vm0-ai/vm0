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

interface TestBluetoothRequestDeviceOptions {
  readonly acceptAllDevices?: boolean;
  readonly filters?: readonly {
    readonly services?: readonly string[];
    readonly namePrefix?: string;
  }[];
  readonly optionalServices?: readonly string[];
}

interface TestGattCharacteristic extends EventTarget {
  readonly value?: DataView;
  readValue(): Promise<DataView>;
  startNotifications?: () => Promise<TestGattCharacteristic>;
  writeValueWithResponse?: (value: BufferSource) => Promise<void>;
  writeValue?: (value: BufferSource) => Promise<void>;
}

interface TestGattService {
  getCharacteristic(uuid: string): Promise<TestGattCharacteristic>;
}

interface TestGattServer {
  readonly connected: boolean;
  connect(): Promise<TestGattServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<TestGattService>;
}

interface TestBluetoothDevice extends EventTarget {
  readonly name?: string;
  readonly gatt?: TestGattServer;
}

interface TestBluetooth {
  requestDevice(
    options: TestBluetoothRequestDeviceOptions,
  ): Promise<TestBluetoothDevice>;
}

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function encodeDataView(value: string): DataView {
  const encoded = new TextEncoder().encode(value);
  return new DataView(encoded.buffer);
}

function dataViewFromBufferSource(value: BufferSource): DataView {
  if (value instanceof ArrayBuffer) {
    return new DataView(value);
  }
  return new DataView(value.buffer, value.byteOffset, value.byteLength);
}

function replaceProperty(
  target: object,
  property: string,
  value: unknown,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  Object.defineProperty(target, property, {
    configurable: true,
    value,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(target, property, descriptor);
        return;
      }
      Reflect.deleteProperty(target, property);
    },
    { once: true },
  );
}

class TestBb0Characteristic
  extends EventTarget
  implements TestGattCharacteristic
{
  value?: DataView;
  readonly startNotifications?: () => Promise<TestGattCharacteristic>;
  readonly writeValueWithResponse?: (value: BufferSource) => Promise<void>;
  readonly writeValue?: (value: BufferSource) => Promise<void>;

  constructor(
    private readonly readTextValue: string,
    options: {
      readonly notifications?: boolean;
      readonly writeMode?: "response" | "legacy";
    } = {},
  ) {
    super();
    if (options.notifications !== false) {
      this.startNotifications = () => {
        return Promise.resolve(this);
      };
    }
    if (options.writeMode === "legacy") {
      this.writeValue = (value: BufferSource) => {
        this.value = dataViewFromBufferSource(value);
        return Promise.resolve();
      };
      return;
    }
    this.writeValueWithResponse = (value: BufferSource) => {
      this.value = dataViewFromBufferSource(value);
      return Promise.resolve();
    };
  }

  readValue(): Promise<DataView> {
    return Promise.resolve(encodeDataView(this.readTextValue));
  }
}

class TestBb0GattServer implements TestGattServer {
  private connectionState = false;

  constructor(private readonly service: TestGattService) {}

  get connected(): boolean {
    return this.connectionState;
  }

  connect(): Promise<TestGattServer> {
    this.connectionState = true;
    return Promise.resolve(this);
  }

  disconnect(): void {
    this.connectionState = false;
  }

  getPrimaryService(): Promise<TestGattService> {
    return Promise.resolve(this.service);
  }
}

class TestBb0Device extends EventTarget implements TestBluetoothDevice {
  readonly gatt: TestGattServer;

  constructor(
    readonly name: string | undefined,
    infoText: string,
    options: {
      readonly notifications?: boolean;
      readonly writeMode?: "response" | "legacy";
    } = {},
  ) {
    super();
    const info = new TestBb0Characteristic(infoText, {
      notifications: options.notifications,
    });
    const config = new TestBb0Characteristic("", {
      writeMode: options.writeMode,
    });
    this.gatt = new TestBb0GattServer({
      getCharacteristic: (uuid: string) => {
        return Promise.resolve(uuid.includes("0002") ? info : config);
      },
    });
  }
}

function mockBluetooth(device: TestBluetoothDevice | Error): void {
  replaceProperty(window, "isSecureContext", true);
  replaceProperty(navigator, "userAgentData", {
    brands: [{ brand: "Chromium", version: "120" }],
  });
  const bluetooth: TestBluetooth = {
    requestDevice: () => {
      return device instanceof Error
        ? Promise.reject(device)
        : Promise.resolve(device);
    },
  };
  replaceProperty(navigator, "bluetooth", bluetooth);
}

function dispatchGattDisconnected(device: TestBluetoothDevice): void {
  device.gatt?.disconnect();
  device.dispatchEvent(new Event("gattserverdisconnected"));
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

  it("shows the missing Web Bluetooth reason in a supported browser shell", async () => {
    replaceProperty(window, "isSecureContext", true);
    replaceProperty(navigator, "userAgentData", {
      brands: [{ brand: "Chromium", version: "120" }],
    });
    replaceProperty(navigator, "bluetooth", undefined);

    detachedSetupPage({ context, path: "/device/bb0" });

    await waitFor(() => {
      expect(
        screen.getByText("This browser does not expose navigator.bluetooth."),
      ).toBeInTheDocument();
    });
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

  it("keeps a selected device without GATT visible as a retryable connection error", async () => {
    mockBluetooth(new EventTarget() as TestBluetoothDevice);

    detachedSetupPage({ context, path: "/device/bb0" });

    await waitFor(() => {
      expect(buttonByText("Connect BB0")).not.toBeDisabled();
    });
    click(buttonByText("Connect BB0"));

    await waitFor(() => {
      expect(
        screen.getByText("Selected bb0 device does not expose GATT."),
      ).toBeInTheDocument();
      expect(buttonByText("Connect BB0")).not.toBeDisabled();
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

  it("handles legacy BB0 info and browser disconnect events during Wi-Fi setup", async () => {
    const device = new TestBb0Device(
      undefined,
      "device_id=bb0-key-value; firmware=9.9.9; state=setup; code ABCD-2345",
      { notifications: false, writeMode: "legacy" },
    );
    mockBluetooth(device);

    detachedSetupPage({ context, path: "/device/bb0" });

    await waitFor(() => {
      expect(buttonByText("Connect BB0")).not.toBeDisabled();
    });
    click(buttonByText("Connect BB0"));

    await waitFor(() => {
      expect(screen.getByText("Connected · BB0")).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Wi-Fi SSID"), "Zero-Lab");
    click(buttonByText("Send Wi-Fi"));

    await waitFor(() => {
      expect(screen.getAllByText("Wi-Fi sent")).not.toHaveLength(0);
    });

    dispatchGattDisconnected(device);

    await waitFor(() => {
      expect(screen.queryByText("Connected · BB0")).not.toBeInTheDocument();
      expect(buttonByText("Connect BB0")).not.toBeDisabled();
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
