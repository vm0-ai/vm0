import type { AppRoute } from "@ts-rest/core";
import { vi } from "vitest";

import {
  getAuthTokenHistory,
  hasSubscription,
  rejectNextAblySubscribe,
  triggerAblyConnectionClosed,
  triggerAblyEvent,
  triggerAblyReauth,
  triggerAblyReconnect,
} from "../../mocks/ably.ts";
import {
  setMockTeam,
  setMockComposesList,
} from "../../mocks/handlers/api-agents.ts";
import { setMockRedeemResponse } from "../../mocks/handlers/api-billing.ts";
import { setMockConnectors } from "../../mocks/handlers/api-connectors.ts";
import { setMockAgentPhoneIntegration } from "../../mocks/handlers/api-integrations-agentphone.ts";
import {
  createDefaultMockGithubIntegration,
  setMockGithubIntegration,
} from "../../mocks/handlers/api-integrations-github.ts";
import { setMockTelegramIntegration } from "../../mocks/handlers/api-integrations-telegram.ts";
import { setMockOnboardingStatus } from "../../mocks/handlers/api-onboarding.ts";
import { setMockOrg } from "../../mocks/handlers/api-org.ts";
import { setMockOrgMembers } from "../../mocks/handlers/api-org-members.ts";
import { setMockOrgModelPolicies } from "../../mocks/handlers/api-org-model-policies.ts";
import { setMockOrgModelProviders } from "../../mocks/handlers/api-org-model-providers.ts";
import { setMockPersonalModelProviders } from "../../mocks/handlers/api-personal-model-providers.ts";
import { setMockUserModelPreference } from "../../mocks/handlers/api-user-model-preference.ts";
import { setMockUserPreferences } from "../../mocks/handlers/api-user-preferences.ts";
import { setMockAutomations } from "../../mocks/handlers/automations-store.ts";
import {
  createMockApi,
  createMockHttp,
  type HttpResolverWithContext,
  type MockHandler,
  type SignalContextLike,
} from "../../mocks/msw-contract.ts";
import { server } from "../../mocks/server.ts";
import {
  mockUploadPending,
  mockUploadSuccess,
} from "../../mocks/upload-helpers.ts";
import { createDeferredPromise } from "../utils.ts";

interface WindowOpenCall {
  url: string | null;
  target: string | null;
  features: string | null;
}

interface BrowserOpenMock {
  calls: WindowOpenCall[];
  openedWindow: Window | null;
}

interface LocationAssignMock {
  calls: string[];
}

interface ClipboardWriteMock {
  writes: string[];
}

interface ClipboardRichWriteMock {
  writes: ClipboardItem[][];
}

interface BrowserDownload {
  readonly url: string;
  readonly filename: string;
  readonly blob: Blob | null;
}

interface BrowserDownloadMock {
  readonly downloads: BrowserDownload[];
  readonly revokedUrls: string[];
}

interface ImageDimensionsMockValue {
  width: number;
  height: number;
}

type ImageDimensionsMockResult = ImageDimensionsMockValue | null;

interface Bb0BluetoothRequestDeviceOptions {
  readonly acceptAllDevices?: boolean;
  readonly filters?: readonly {
    readonly services?: readonly string[];
    readonly namePrefix?: string;
  }[];
  readonly optionalServices?: readonly string[];
}

interface Bb0BluetoothRemoteGATTCharacteristic extends EventTarget {
  value?: DataView;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<Bb0BluetoothRemoteGATTCharacteristic>;
  writeValueWithResponse(value: BufferSource): Promise<void>;
}

interface Bb0BluetoothRemoteGATTService {
  getCharacteristic(
    uuid: string,
  ): Promise<Bb0BluetoothRemoteGATTCharacteristic>;
}

interface Bb0BluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<Bb0BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<Bb0BluetoothRemoteGATTService>;
}

interface Bb0BluetoothDevice extends EventTarget {
  readonly name: string;
  readonly gatt: Bb0BluetoothRemoteGATTServer;
}

interface Bb0Bluetooth {
  requestDevice(
    options: Bb0BluetoothRequestDeviceOptions,
  ): Promise<Bb0BluetoothDevice>;
}

interface MockWindow extends Window {
  closed: boolean;
  close: () => void;
}

type OmitFirst<T extends readonly unknown[]> = T extends readonly [
  unknown,
  ...infer Rest,
]
  ? Rest
  : never;

export function createTestMocks(getSignal: () => AbortSignal) {
  const signalContext: SignalContextLike = {
    get signal() {
      return getSignal();
    },
  };
  const mockApi = createMockApi(signalContext);
  const mockHttp = createMockHttp(signalContext);

  return {
    api: <R extends AppRoute>(route: R, handler: MockHandler<R>) => {
      server.use(mockApi(route, handler));
    },
    http: {
      get: (
        path: Parameters<typeof mockHttp.get>[0],
        resolver: HttpResolverWithContext,
      ) => {
        server.use(mockHttp.get(path, resolver));
      },
      post: (
        path: Parameters<typeof mockHttp.post>[0],
        resolver: HttpResolverWithContext,
      ) => {
        server.use(mockHttp.post(path, resolver));
      },
      put: (
        path: Parameters<typeof mockHttp.put>[0],
        resolver: HttpResolverWithContext,
      ) => {
        server.use(mockHttp.put(path, resolver));
      },
      patch: (
        path: Parameters<typeof mockHttp.patch>[0],
        resolver: HttpResolverWithContext,
      ) => {
        server.use(mockHttp.patch(path, resolver));
      },
      delete: (
        path: Parameters<typeof mockHttp.delete>[0],
        resolver: HttpResolverWithContext,
      ) => {
        server.use(mockHttp.delete(path, resolver));
      },
    },
    data: {
      team: (...args: Parameters<typeof setMockTeam>) => {
        setMockTeam(...args);
      },
      composesList: (...args: Parameters<typeof setMockComposesList>) => {
        setMockComposesList(...args);
      },
      org: (...args: Parameters<typeof setMockOrg>) => {
        setMockOrg(...args);
      },
      orgMembers: (...args: Parameters<typeof setMockOrgMembers>) => {
        setMockOrgMembers(...args);
      },
      connectors: (...args: Parameters<typeof setMockConnectors>) => {
        setMockConnectors(...args);
      },
      userPreferences: (...args: Parameters<typeof setMockUserPreferences>) => {
        setMockUserPreferences(...args);
      },
      userModelPreference: (
        ...args: Parameters<typeof setMockUserModelPreference>
      ) => {
        setMockUserModelPreference(...args);
      },
      redeemResponse: (...args: Parameters<typeof setMockRedeemResponse>) => {
        setMockRedeemResponse(...args);
      },
      automations: (...args: Parameters<typeof setMockAutomations>) => {
        setMockAutomations(...args);
      },
      githubIntegration: (
        ...args: Parameters<typeof setMockGithubIntegration>
      ) => {
        setMockGithubIntegration(...args);
      },
      defaultGithubIntegration: createDefaultMockGithubIntegration,
      agentPhoneIntegration: (
        ...args: Parameters<typeof setMockAgentPhoneIntegration>
      ) => {
        setMockAgentPhoneIntegration(...args);
      },
      telegramIntegration: (
        ...args: Parameters<typeof setMockTelegramIntegration>
      ) => {
        setMockTelegramIntegration(...args);
      },
      orgModelProviders: (
        ...args: Parameters<typeof setMockOrgModelProviders>
      ) => {
        setMockOrgModelProviders(...args);
      },
      orgModelPolicies: (
        ...args: Parameters<typeof setMockOrgModelPolicies>
      ) => {
        setMockOrgModelPolicies(...args);
      },
      personalModelProviders: (
        ...args: Parameters<typeof setMockPersonalModelProviders>
      ) => {
        setMockPersonalModelProviders(...args);
      },
      onboardingStatus: (
        ...args: Parameters<typeof setMockOnboardingStatus>
      ) => {
        setMockOnboardingStatus(...args);
      },
    },
    browser: {
      open: (openedWindow: Window | null = null): BrowserOpenMock => {
        return mockWindowOpen(getSignal(), openedWindow);
      },
      locationAssign: (): LocationAssignMock => {
        return mockLocationAssign(getSignal());
      },
      authWindow: (): MockWindow => {
        return createMockWindow();
      },
      matchMedia: (matches: boolean | ((query: string) => boolean)): void => {
        mockMatchMedia(getSignal(), matches);
      },
      standaloneDisplayMode: (enabled: boolean): void => {
        mockMatchMedia(getSignal(), (query) => {
          return query === "(display-mode: standalone)" ? enabled : false;
        });
      },
      userAgent: (ua: string): void => {
        const spy = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
        restoreOnAbort(getSignal(), () => {
          spy.mockRestore();
        });
      },
      clipboardWriteText: (): ClipboardWriteMock => {
        return mockClipboardWriteText(getSignal());
      },
      clipboardWrite: (): ClipboardRichWriteMock => {
        return mockClipboardWrite(getSignal());
      },
      blobDownload: (): BrowserDownloadMock => {
        return mockBlobDownload(getSignal());
      },
      audioContext: (): void => {
        mockAudioContext(getSignal());
      },
      voiceInput: (): void => {
        mockVoiceInput(getSignal());
      },
      imageDimensions: (
        results:
          | ImageDimensionsMockResult
          | readonly ImageDimensionsMockResult[],
      ): void => {
        mockImageDimensions(getSignal(), results);
      },
      webBluetoothSupport: (): void => {
        mockSupportedWebBluetooth(getSignal());
      },
      bb0Device: (): void => {
        mockBb0BluetoothDevice(getSignal());
      },
    },
    upload: {
      success: (...args: Parameters<typeof mockUploadSuccess>) => {
        server.use(...mockUploadSuccess(...args));
      },
      pending: (...args: OmitFirst<Parameters<typeof mockUploadPending>>) => {
        server.use(...mockUploadPending(signalContext, ...args));
      },
    },
    ably: {
      trigger: triggerAblyEvent,
      triggerReconnect: triggerAblyReconnect,
      triggerReauth: triggerAblyReauth,
      triggerConnectionClosed: triggerAblyConnectionClosed,
      rejectNextSubscribe: rejectNextAblySubscribe,
      hasSubscription,
      getAuthTokenHistory,
    },
    deferred: <T>() => {
      return createDeferredPromise<T>(getSignal());
    },
  };
}

export type TestMocks = ReturnType<typeof createTestMocks>;

function mockWindowOpen(
  signal: AbortSignal,
  openedWindow: Window | null,
): BrowserOpenMock {
  const calls: WindowOpenCall[] = [];
  const spy = vi
    .spyOn(window, "open")
    .mockImplementation((url, target, features) => {
      calls.push({
        url: url === undefined ? null : String(url),
        target: target === undefined ? null : target,
        features: features === undefined ? null : features,
      });
      return openedWindow;
    });
  restoreOnAbort(signal, () => {
    spy.mockRestore();
  });
  return { calls, openedWindow };
}

function mockLocationAssign(signal: AbortSignal): LocationAssignMock {
  const calls: string[] = [];
  const spy = vi.spyOn(window.location, "assign").mockImplementation((url) => {
    calls.push(String(url));
  });
  restoreOnAbort(signal, () => {
    spy.mockRestore();
  });
  return { calls };
}

function createMockWindow(): MockWindow {
  const mockWindow = {
    closed: false,
    close: () => {
      mockWindow.closed = true;
    },
  } as MockWindow;
  return mockWindow;
}

function mockMatchMedia(
  signal: AbortSignal,
  matches: boolean | ((query: string) => boolean),
): void {
  const spy = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const mediaQueryList: MediaQueryList = {
      matches: typeof matches === "function" ? matches(query) : matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    return mediaQueryList;
  });
  restoreOnAbort(signal, () => {
    spy.mockRestore();
  });
}

function mockClipboardWriteText(signal: AbortSignal): ClipboardWriteMock {
  const writes: string[] = [];
  const spy = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockImplementation((text) => {
      writes.push(text);
      return Promise.resolve();
    });
  restoreOnAbort(signal, () => {
    spy.mockRestore();
  });
  return { writes };
}

function mockClipboardWrite(signal: AbortSignal): ClipboardRichWriteMock {
  const writes: ClipboardItem[][] = [];
  const spy = vi
    .spyOn(navigator.clipboard, "write")
    .mockImplementation((items) => {
      writes.push(items);
      return Promise.resolve();
    });
  restoreOnAbort(signal, () => {
    spy.mockRestore();
  });
  return { writes };
}

function mockBlobDownload(signal: AbortSignal): BrowserDownloadMock {
  const downloads: BrowserDownload[] = [];
  const revokedUrls: string[] = [];
  const blobs = new Map<string, Blob>();
  let objectUrlIndex = 0;

  const createObjectUrlDescriptor = defineWindowProperty(
    URL,
    "createObjectURL",
    (object: Blob | MediaSource) => {
      objectUrlIndex += 1;
      const url = `blob:mock-download-${objectUrlIndex}`;
      if (object instanceof Blob) {
        blobs.set(url, object);
      }
      return url;
    },
  );
  const revokeObjectUrlDescriptor = defineWindowProperty(
    URL,
    "revokeObjectURL",
    (url: string) => {
      revokedUrls.push(url);
    },
  );
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({
        url: this.href,
        filename: this.download,
        blob: blobs.get(this.href) ?? null,
      });
    });

  restoreOnAbort(signal, () => {
    restoreWindowProperty(URL, "createObjectURL", createObjectUrlDescriptor);
    restoreWindowProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
    clickSpy.mockRestore();
  });

  return { downloads, revokedUrls };
}

function mockAudioContext(signal: AbortSignal): void {
  class TestAudioBuffer {
    readonly duration: number;
    private readonly channelData: Float32Array;

    constructor(length: number, sampleRate: number) {
      this.duration = length / sampleRate;
      this.channelData = new Float32Array(length);
    }

    getChannelData(_channel: number): Float32Array {
      return this.channelData;
    }
  }

  class TestAudioBufferSource {
    buffer: AudioBuffer | null = null;

    connect(_destination: AudioDestinationNode): void {}

    start(_when?: number): void {}
  }

  class TestAudioContext {
    readonly currentTime = 0;
    readonly destination = {} as AudioDestinationNode;

    resume(): Promise<void> {
      return Promise.resolve();
    }

    close(): Promise<void> {
      return Promise.resolve();
    }

    createBuffer(
      _numberOfChannels: number,
      length: number,
      sampleRate: number,
    ): AudioBuffer {
      return new TestAudioBuffer(length, sampleRate) as unknown as AudioBuffer;
    }

    createBufferSource(): AudioBufferSourceNode {
      return new TestAudioBufferSource() as unknown as AudioBufferSourceNode;
    }
  }

  const descriptor = defineWindowProperty(
    window,
    "AudioContext",
    TestAudioContext,
  );

  restoreOnAbort(signal, () => {
    restoreWindowProperty(window, "AudioContext", descriptor);
  });
}

function mockVoiceInput(signal: AbortSignal): void {
  const mediaRecorderGlobal = globalThis as typeof globalThis & {
    MediaRecorder?: typeof MediaRecorder;
  };
  const stream = {
    getTracks: () => {
      return [
        {
          stop: () => {
            return undefined;
          },
        },
      ];
    },
  } as unknown as MediaStream;

  type RecorderDataEvent = Event & { data: Blob };

  class TestMediaRecorder extends EventTarget {
    static isTypeSupported(type: string): boolean {
      return type === "audio/webm";
    }

    mimeType: string;
    ondataavailable: ((event: RecorderDataEvent) => void) | null = null;
    state: RecordingState = "inactive";

    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      super();
      this.mimeType = options?.mimeType ?? "audio/webm";
    }

    start(): void {
      this.state = "recording";
    }

    stop(): void {
      if (this.state === "inactive") {
        return;
      }
      this.state = "inactive";
      const event = new Event("dataavailable") as RecorderDataEvent;
      Object.defineProperty(event, "data", {
        value: new Blob(["voice"], { type: this.mimeType }),
      });
      this.ondataavailable?.(event);
      this.dispatchEvent(new Event("stop"));
    }
  }

  const mediaDevicesDescriptor = defineWindowProperty(
    navigator,
    "mediaDevices",
    {
      enumerateDevices: () => {
        return Promise.resolve([] as MediaDeviceInfo[]);
      },
      getUserMedia: () => {
        return Promise.resolve(stream);
      },
    },
  );
  const mediaRecorderDescriptor = defineWindowProperty(
    mediaRecorderGlobal,
    "MediaRecorder",
    TestMediaRecorder as unknown as typeof MediaRecorder,
  );

  restoreOnAbort(signal, () => {
    restoreWindowProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
    restoreWindowProperty(
      mediaRecorderGlobal,
      "MediaRecorder",
      mediaRecorderDescriptor,
    );
  });
}

function mockImageDimensions(
  signal: AbortSignal,
  results: ImageDimensionsMockResult | readonly ImageDimensionsMockResult[],
): void {
  const pendingResults = Array.isArray(results) ? [...results] : [results];
  let objectUrlIndex = 0;

  class TestImage extends EventTarget {
    naturalWidth = 0;
    naturalHeight = 0;

    set src(_value: string) {
      const result =
        pendingResults.length > 1
          ? pendingResults.shift()
          : (pendingResults[0] ?? null);
      if (result) {
        this.naturalWidth = result.width;
        this.naturalHeight = result.height;
      }
      queueMicrotask(() => {
        this.dispatchEvent(new Event(result ? "load" : "error"));
      });
    }
  }

  const createObjectUrlDescriptor = defineWindowProperty(
    URL,
    "createObjectURL",
    (_object: Blob | MediaSource) => {
      objectUrlIndex += 1;
      return `blob:mock-image-${objectUrlIndex}`;
    },
  );
  const revokeObjectUrlDescriptor = defineWindowProperty(
    URL,
    "revokeObjectURL",
    (_url: string) => {},
  );
  const imageDescriptor = defineWindowProperty(
    window,
    "Image",
    TestImage as unknown as typeof Image,
  );

  restoreOnAbort(signal, () => {
    restoreWindowProperty(URL, "createObjectURL", createObjectUrlDescriptor);
    restoreWindowProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
    restoreWindowProperty(window, "Image", imageDescriptor);
  });
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

  restoreOnAbort(signal, () => {
    restoreWindowProperty(window, "isSecureContext", secureContextDescriptor);
    restoreWindowProperty(navigator, "userAgentData", userAgentDataDescriptor);
    restoreWindowProperty(navigator, "bluetooth", bluetoothDescriptor);
  });
}

class MockBb0Characteristic
  extends EventTarget
  implements Bb0BluetoothRemoteGATTCharacteristic
{
  value?: DataView;

  constructor(private readonly readTextValue: string) {
    super();
  }

  readValue(): Promise<DataView> {
    return Promise.resolve(encodeDataView(this.readTextValue));
  }

  startNotifications(): Promise<Bb0BluetoothRemoteGATTCharacteristic> {
    return Promise.resolve(this);
  }

  writeValueWithResponse(value: BufferSource): Promise<void> {
    this.value = bufferSourceDataView(value);
    return Promise.resolve();
  }
}

class MockBb0GattServer implements Bb0BluetoothRemoteGATTServer {
  private connectionState = true;

  constructor(private readonly service: Bb0BluetoothRemoteGATTService) {}

  get connected(): boolean {
    return this.connectionState;
  }

  connect(): Promise<Bb0BluetoothRemoteGATTServer> {
    this.connectionState = true;
    return Promise.resolve(this);
  }

  disconnect(): void {
    this.connectionState = false;
  }

  getPrimaryService(_uuid: string): Promise<Bb0BluetoothRemoteGATTService> {
    return Promise.resolve(this.service);
  }
}

class MockBb0Device extends EventTarget implements Bb0BluetoothDevice {
  readonly name = "Zero-Buddy-Test";
  readonly gatt: Bb0BluetoothRemoteGATTServer;

  constructor() {
    super();
    const info = new MockBb0Characteristic(
      JSON.stringify({
        protocol: "bb0-provisioning-v1",
        device_id: "bb0-test",
        device_code: "ABCD-2345",
        ble_session_nonce: "bb0-session-nonce",
        firmware_version: "1.2.3",
        provisioning_state: "setup",
      }),
    );
    const config = new MockBb0Characteristic("");
    const service: Bb0BluetoothRemoteGATTService = {
      getCharacteristic: (uuid: string) => {
        return Promise.resolve(uuid.includes("0002") ? info : config);
      },
    };
    this.gatt = new MockBb0GattServer(service);
  }
}

function mockBb0BluetoothDevice(signal: AbortSignal): void {
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
  const bluetooth: Bb0Bluetooth = {
    requestDevice: () => {
      return Promise.resolve(new MockBb0Device());
    },
  };
  const bluetoothDescriptor = defineWindowProperty(
    navigator,
    "bluetooth",
    bluetooth,
  );

  restoreOnAbort(signal, () => {
    restoreWindowProperty(window, "isSecureContext", secureContextDescriptor);
    restoreWindowProperty(navigator, "userAgentData", userAgentDataDescriptor);
    restoreWindowProperty(navigator, "bluetooth", bluetoothDescriptor);
  });
}

function encodeDataView(value: string): DataView {
  const encoded = new TextEncoder().encode(value);
  return new DataView(encoded.buffer);
}

function bufferSourceDataView(value: BufferSource): DataView {
  if (value instanceof ArrayBuffer) {
    return new DataView(value);
  }
  return new DataView(value.buffer, value.byteOffset, value.byteLength);
}

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

function restoreOnAbort(signal: AbortSignal, restore: () => void): void {
  signal.addEventListener("abort", restore, { once: true });
}
