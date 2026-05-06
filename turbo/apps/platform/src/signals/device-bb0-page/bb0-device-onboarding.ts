import { command, computed, state } from "ccstate";
import { bb0DeviceConfirmContract } from "@vm0/api-contracts/contracts/device-token";
import { toast } from "@vm0/ui/components/ui/sonner";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { jsonParseOr } from "../utils.ts";

export const BB0_PROVISIONING_SERVICE_UUID =
  "bb000001-8f16-4b2a-9bb0-000000000001";

const BB0_DEVICE_NAME_PREFIX = "Zero-Buddy-";
const BB0_INFO_CHARACTERISTIC_UUID = "bb000002-8f16-4b2a-9bb0-000000000001";
const BB0_CONFIG_CHARACTERISTIC_UUID = "bb000003-8f16-4b2a-9bb0-000000000001";
const BB0_DEVICE_CODE_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

type Bb0ConnectionStatus =
  | "idle"
  | "checking"
  | "connecting"
  | "connected"
  | "disconnected";

type Bb0OperationStatus =
  | "idle"
  | "reading"
  | "sending_wifi"
  | "confirming_code"
  | "confirmed";

interface Bb0BrowserSupport {
  readonly supported: boolean;
  readonly reason: string | null;
}

interface Bb0DeviceInfo {
  readonly name: string | null;
  readonly protocol: string;
  readonly deviceId: string;
  readonly deviceCode: string;
  readonly bleSessionNonce: string;
  readonly firmwareVersion: string;
  readonly provisioningState: string;
  readonly errorCode: string;
  readonly rawInfo: string;
}

interface Bb0ProvisioningState {
  readonly connectionStatus: Bb0ConnectionStatus;
  readonly operationStatus: Bb0OperationStatus;
  readonly infoNotificationsEnabled: boolean;
  readonly wifiSent: boolean;
}

interface Bb0BluetoothRequestFilter {
  readonly services?: readonly string[];
  readonly namePrefix?: string;
}

interface Bb0BluetoothRequestDeviceOptions {
  readonly acceptAllDevices?: boolean;
  readonly filters?: readonly Bb0BluetoothRequestFilter[];
  readonly optionalServices?: readonly string[];
}

interface Bb0Bluetooth {
  requestDevice(
    options: Bb0BluetoothRequestDeviceOptions,
  ): Promise<Bb0BluetoothDevice>;
}

interface Bb0BluetoothDevice extends EventTarget {
  readonly name?: string;
  readonly gatt?: Bb0BluetoothRemoteGATTServer;
}

interface Bb0BluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<Bb0BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<Bb0BluetoothRemoteGATTService>;
}

interface Bb0BluetoothRemoteGATTService {
  getCharacteristic(
    uuid: string,
  ): Promise<Bb0BluetoothRemoteGATTCharacteristic>;
}

interface Bb0BluetoothRemoteGATTCharacteristic extends EventTarget {
  readValue(): Promise<DataView>;
  startNotifications?(): Promise<Bb0BluetoothRemoteGATTCharacteristic>;
  stopNotifications?(): Promise<Bb0BluetoothRemoteGATTCharacteristic>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  writeValue?(value: BufferSource): Promise<void>;
}

interface Bb0BleSession {
  readonly device: Bb0BluetoothDevice;
  readonly server: Bb0BluetoothRemoteGATTServer;
  readonly characteristics: {
    readonly info: Bb0BluetoothRemoteGATTCharacteristic;
    readonly config: Bb0BluetoothRemoteGATTCharacteristic;
  };
}

interface Bb0ConnectOptions {
  readonly acceptAllDevices: boolean;
}

interface NavigatorWithBb0Bluetooth extends Navigator {
  readonly bluetooth?: Bb0Bluetooth;
  readonly userAgentData?: {
    readonly brands: readonly {
      readonly brand: string;
      readonly version: string;
    }[];
  };
}

function createEmptyDeviceInfo(): Bb0DeviceInfo {
  return {
    name: null,
    protocol: "",
    deviceId: "",
    deviceCode: "",
    bleSessionNonce: "",
    firmwareVersion: "",
    provisioningState: "not connected",
    errorCode: "",
    rawInfo: "",
  };
}

function createEmptyProvisioningState(): Bb0ProvisioningState {
  return {
    connectionStatus: "idle",
    operationStatus: "idle",
    infoNotificationsEnabled: false,
    wifiSent: false,
  };
}

const internalDeviceInfo$ = state<Bb0DeviceInfo>(createEmptyDeviceInfo());
const internalProvisioningState$ = state<Bb0ProvisioningState>(
  createEmptyProvisioningState(),
);
const internalBleSession$ = state<Bb0BleSession | null>(null);
const internalWifiSsid$ = state("");
const internalWifiPassword$ = state("");
const internalDeviceCodeInput$ = state("");

export const bb0DeviceInfo$ = computed((get) => {
  return get(internalDeviceInfo$);
});

export const bb0ProvisioningState$ = computed((get) => {
  return get(internalProvisioningState$);
});

export const bb0WifiSsid$ = computed((get) => {
  return get(internalWifiSsid$);
});

export const bb0WifiPassword$ = computed((get) => {
  return get(internalWifiPassword$);
});

export const bb0DeviceCodeInput$ = computed((get) => {
  return get(internalDeviceCodeInput$);
});

export const bb0BrowserSupport$ = computed((): Bb0BrowserSupport => {
  return getBrowserSupport();
});

export const bb0CanSendWifi$ = computed((get) => {
  const stateValue = get(internalProvisioningState$);
  const ssid = get(internalWifiSsid$).trim();
  return stateValue.connectionStatus === "connected" && ssid.length > 0;
});

export const bb0CanConfirmCode$ = computed((get) => {
  const stateValue = get(internalProvisioningState$);
  const deviceCode = normalizeDeviceCode(get(internalDeviceCodeInput$));
  return (
    stateValue.operationStatus !== "confirmed" &&
    BB0_DEVICE_CODE_PATTERN.test(deviceCode)
  );
});

export const setBb0WifiSsid$ = command(({ set }, value: string) => {
  set(internalWifiSsid$, value);
});

export const setBb0WifiPassword$ = command(({ set }, value: string) => {
  set(internalWifiPassword$, value);
});

export const setBb0DeviceCodeInput$ = command(({ set }, value: string) => {
  set(internalDeviceCodeInput$, normalizeDeviceCode(value));
});

export const resetBb0Onboarding$ = command(({ get, set }) => {
  const session = get(internalBleSession$);
  if (session?.server.connected) {
    session.server.disconnect();
  }
  set(internalBleSession$, null);
  set(internalDeviceInfo$, createEmptyDeviceInfo());
  set(internalProvisioningState$, createEmptyProvisioningState());
  set(internalWifiSsid$, "");
  set(internalWifiPassword$, "");
  set(internalDeviceCodeInput$, "");
});

export const connectBb0Device$ = command(
  async ({ set }, options: Bb0ConnectOptions, signal: AbortSignal) => {
    set(internalProvisioningState$, (current): Bb0ProvisioningState => {
      return {
        ...current,
        connectionStatus: "checking",
        operationStatus: "idle",
      };
    });

    const support = getBrowserSupport();
    if (!support.supported) {
      throw new Error(support.reason ?? "Web Bluetooth is unavailable.");
    }

    set(internalProvisioningState$, (current): Bb0ProvisioningState => {
      return { ...current, connectionStatus: "connecting" };
    });

    const bluetooth = getBluetooth();
    const device = await bluetooth.requestDevice(
      createRequestDeviceOptions(options.acceptAllDevices),
    );
    signal.throwIfAborted();

    if (!device.gatt) {
      throw new Error("Selected bb0 device does not expose GATT.");
    }

    const server = await device.gatt.connect();
    signal.throwIfAborted();
    const service = await server.getPrimaryService(
      BB0_PROVISIONING_SERVICE_UUID,
    );
    signal.throwIfAborted();
    const session: Bb0BleSession = {
      device,
      server,
      characteristics: {
        info: await service.getCharacteristic(BB0_INFO_CHARACTERISTIC_UUID),
        config: await service.getCharacteristic(BB0_CONFIG_CHARACTERISTIC_UUID),
      },
    };
    signal.throwIfAborted();

    device.addEventListener(
      "gattserverdisconnected",
      () => {
        set(internalBleSession$, null);
        set(internalProvisioningState$, (current): Bb0ProvisioningState => {
          return {
            ...current,
            connectionStatus: "disconnected",
            operationStatus: "idle",
            infoNotificationsEnabled: false,
          };
        });
      },
      { signal },
    );

    set(internalBleSession$, session);
    set(internalDeviceInfo$, await readBb0Status(session));
    signal.throwIfAborted();
    const infoNotificationsEnabled = await enableBb0InfoNotifications(
      session,
      signal,
      (info) => {
        set(internalDeviceInfo$, info);
      },
    );
    signal.throwIfAborted();
    set(internalProvisioningState$, (current): Bb0ProvisioningState => {
      return {
        ...current,
        connectionStatus: "connected",
        operationStatus: "idle",
        infoNotificationsEnabled,
      };
    });
  },
);

export const refreshBb0DeviceStatus$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalProvisioningState$, (current): Bb0ProvisioningState => {
      return { ...current, operationStatus: "reading" };
    });

    const session = requireSession(get(internalBleSession$));
    set(internalDeviceInfo$, await readBb0Status(session));
    signal.throwIfAborted();
    set(internalProvisioningState$, (current): Bb0ProvisioningState => {
      return { ...current, operationStatus: "idle" };
    });
  },
);

export const sendBb0WifiCredentials$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalProvisioningState$, (current): Bb0ProvisioningState => {
      return { ...current, operationStatus: "sending_wifi" };
    });

    const ssid = get(internalWifiSsid$).trim();
    if (ssid.length === 0) {
      throw new Error("Wi-Fi SSID is required.");
    }
    const session = requireSession(get(internalBleSession$));
    await writeConfig(session, {
      type: "wifi",
      wifi_ssid: ssid,
      wifi_password: get(internalWifiPassword$),
    });
    signal.throwIfAborted();
    set(internalDeviceInfo$, (current): Bb0DeviceInfo => {
      return { ...current, provisioningState: "wifi_received" };
    });
    set(internalProvisioningState$, (current): Bb0ProvisioningState => {
      return {
        ...current,
        operationStatus: "idle",
        wifiSent: true,
      };
    });
    toast.success("Wi-Fi password sent. Check bb0's screen to finish setup.");
  },
);

export const confirmBb0DeviceCode$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const deviceCode = normalizeDeviceCode(get(internalDeviceCodeInput$));
    if (!BB0_DEVICE_CODE_PATTERN.test(deviceCode)) {
      throw new Error(
        "Enter the device code shown on bb0, for example ABCD-2345.",
      );
    }

    set(internalProvisioningState$, (current): Bb0ProvisioningState => {
      return { ...current, operationStatus: "confirming_code" };
    });

    const client = get(zeroClient$)(bb0DeviceConfirmContract);
    await accept(
      client.confirm({
        body: { device_code: deviceCode },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(internalProvisioningState$, (current): Bb0ProvisioningState => {
      return { ...current, operationStatus: "confirmed" };
    });
    toast.success("Device code confirmed. Check bb0's screen for final setup.");
  },
);

export const disconnectBb0Device$ = command(({ get, set }) => {
  const session = get(internalBleSession$);
  if (session?.server.connected) {
    session.server.disconnect();
  }
  set(internalBleSession$, null);
  set(internalProvisioningState$, (current): Bb0ProvisioningState => {
    return {
      ...current,
      connectionStatus: "disconnected",
      operationStatus: "idle",
      infoNotificationsEnabled: false,
    };
  });
});

async function readBb0Status(session: Bb0BleSession): Promise<Bb0DeviceInfo> {
  const rawInfo = await readText(session.characteristics.info);
  return parseDeviceInfo(session.device.name ?? null, rawInfo);
}

async function readText(
  characteristic: Bb0BluetoothRemoteGATTCharacteristic,
): Promise<string> {
  const value = await characteristic.readValue();
  return decodeDataView(value);
}

function decodeDataView(value: DataView): string {
  return new TextDecoder()
    .decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    .trim();
}

function enableBb0InfoNotifications(
  session: Bb0BleSession,
  signal: AbortSignal,
  onInfo: (info: Bb0DeviceInfo) => void,
): Promise<boolean> {
  const startNotifications = session.characteristics.info.startNotifications;
  if (!startNotifications) {
    return Promise.resolve(false);
  }

  session.characteristics.info.addEventListener(
    "characteristicvaluechanged",
    (event) => {
      const rawInfo = readNotificationText(event);
      if (!rawInfo) {
        return;
      }
      onInfo(parseDeviceInfo(session.device.name ?? null, rawInfo));
    },
    { signal },
  );

  return startNotifications.call(session.characteristics.info).then(
    () => {
      return true;
    },
    () => {
      return false;
    },
  );
}

function readNotificationText(event: Event): string {
  const target = event.target;
  if (!hasCharacteristicValue(target)) {
    return "";
  }
  return decodeDataView(target.value);
}

function hasCharacteristicValue(
  target: EventTarget | null,
): target is EventTarget & { readonly value: DataView } {
  return (
    target !== null && "value" in target && target.value instanceof DataView
  );
}

async function writeText(
  characteristic: Bb0BluetoothRemoteGATTCharacteristic,
  value: string,
): Promise<void> {
  const encoded = new TextEncoder().encode(value);
  if (characteristic.writeValueWithResponse) {
    await characteristic.writeValueWithResponse(encoded);
    return;
  }
  if (characteristic.writeValue) {
    await characteristic.writeValue(encoded);
    return;
  }
  throw new Error("bb0 BLE characteristic is not writable.");
}

async function writeConfig(
  session: Bb0BleSession,
  payload: Record<string, unknown>,
): Promise<void> {
  await writeText(session.characteristics.config, JSON.stringify(payload));
}

function createRequestDeviceOptions(
  acceptAllDevices: boolean,
): Bb0BluetoothRequestDeviceOptions {
  if (acceptAllDevices) {
    return {
      acceptAllDevices: true,
      optionalServices: [BB0_PROVISIONING_SERVICE_UUID],
    };
  }
  return {
    filters: [{ namePrefix: BB0_DEVICE_NAME_PREFIX }],
    optionalServices: [BB0_PROVISIONING_SERVICE_UUID],
  };
}

function parseDeviceInfo(name: string | null, rawInfo: string): Bb0DeviceInfo {
  const parsed = jsonParseOr<unknown>(rawInfo, null);
  const record = isRecord(parsed) ? parsed : parseKeyValueInfo(rawInfo);

  return {
    name,
    protocol: getStringField(record, ["protocol"]),
    deviceId: getStringField(record, [
      "device_id",
      "deviceId",
      "short_device_id",
      "shortDeviceId",
    ]),
    deviceCode:
      getStringField(record, ["device_code", "deviceCode", "code"]) ||
      findDeviceCode(rawInfo),
    bleSessionNonce: getStringField(record, [
      "ble_session_nonce",
      "bleSessionNonce",
      "session_nonce",
      "sessionNonce",
      "nonce",
    ]),
    firmwareVersion: getStringField(record, [
      "firmware_version",
      "firmwareVersion",
      "firmware",
      "fw",
    ]),
    provisioningState:
      getStringField(record, [
        "provisioning_state",
        "provisioningState",
        "state",
      ]) || (rawInfo ? "reported" : "waiting for Wi-Fi"),
    errorCode: getStringField(record, ["error_code", "errorCode"]),
    rawInfo,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseKeyValueInfo(rawInfo: string): Record<string, unknown> {
  const result: Record<string, string> = {};
  for (const part of rawInfo.split(/[\n;,]+/)) {
    const separatorIndex = part.search(/[:=]/);
    if (separatorIndex <= 0) {
      continue;
    }
    result[part.slice(0, separatorIndex).trim()] = part
      .slice(separatorIndex + 1)
      .trim();
  }
  return result;
}

function getStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value.trim();
    }
  }
  return "";
}

function findDeviceCode(rawInfo: string): string {
  return rawInfo.match(/[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0] ?? "";
}

function normalizeDeviceCode(value: string): string {
  const compact = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (compact.length <= 4) {
    return compact;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}`;
}

function requireSession(session: Bb0BleSession | null): Bb0BleSession {
  if (!session) {
    throw new Error("Connect to bb0 over Bluetooth first.");
  }
  if (!session.server.connected) {
    throw new Error("Bluetooth connection to bb0 is no longer active.");
  }
  return session;
}

function getBrowserSupport(): Bb0BrowserSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {
      supported: false,
      reason: "Web Bluetooth is only available in a browser.",
    };
  }
  if (!window.isSecureContext) {
    return {
      supported: false,
      reason: "Web Bluetooth requires HTTPS or localhost.",
    };
  }
  if (!isChromiumBrowser(navigator)) {
    return {
      supported: false,
      reason: "Web Bluetooth for bb0 setup requires a Chromium-based browser.",
    };
  }
  if (!getBluetoothOrNull()) {
    return {
      supported: false,
      reason: "This browser does not expose navigator.bluetooth.",
    };
  }
  return { supported: true, reason: null };
}

function getBluetooth(): Bb0Bluetooth {
  const bluetooth = getBluetoothOrNull();
  if (!bluetooth) {
    throw new Error("navigator.bluetooth is not available.");
  }
  return bluetooth;
}

function getBluetoothOrNull(): Bb0Bluetooth | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  return (navigator as NavigatorWithBb0Bluetooth).bluetooth ?? null;
}

function isChromiumBrowser(navigatorRef: Navigator): boolean {
  const nav = navigatorRef as NavigatorWithBb0Bluetooth;
  const brands = nav.userAgentData?.brands ?? [];
  if (
    brands.some((brand) => {
      return /Chromium|Google Chrome|Microsoft Edge|Brave|Opera/i.test(
        brand.brand,
      );
    })
  ) {
    return true;
  }

  return /(?:Chrome|Chromium|Edg|OPR)\//.test(navigatorRef.userAgent);
}
