import type { AppRoute } from "@okouai/api-contracts/contracts/trpc-contract";
import { vi } from "vitest";

import {
  deferNextAblySubscribe,
  getAuthTokenHistory,
  hasChannelSubscription,
  hasChannelSubscriptionOnChannel,
  hasSubscription,
  hasSubscriptionOnChannel,
  rejectAblySubscribe,
  rejectNextAblySubscribe,
  triggerAblyConnectionState,
  triggerAblyChannelEvent,
  triggerAblyConnectionClosed,
  triggerAblyEvent,
  triggerAblyFailure,
  triggerAblyReauth,
  triggerAblyReconnect,
  triggerSharedWorkerAblyConnectionState,
  triggerSharedWorkerAblyFailure,
  triggerSharedWorkerAblyReconnect,
} from "../../mocks/ably.ts";
import { setMockAgents } from "../../mocks/handlers/api-agents.ts";
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

interface BrowserScreenOptions {
  readonly height: number;
  readonly pixelRatio: number;
  readonly width: number;
}

interface CanvasRender {
  readonly avatar: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly background: string;
  readonly height: number;
  readonly width: number;
}

interface CanvasRenderingMock {
  readonly renders: CanvasRender[];
}

interface BrowserFedCmOptions {
  readonly credentials?: boolean;
  readonly identityCredential?: boolean;
  readonly secureContext?: boolean;
}

interface BrowserWebAuthnOptions {
  readonly credentials?: boolean;
  readonly platformAuthenticatorResult?: boolean | "error";
  readonly publicKeyCredential?: boolean;
  readonly secureContext?: boolean;
}

interface LocationAssignMock {
  calls: string[];
}

interface StorageWrite {
  readonly key: string;
  readonly value: string;
}

interface StorageWriteMock {
  readonly writes: StorageWrite[];
}

interface ClipboardWriteMock {
  writes: string[];
}

interface ClipboardRichWriteMock {
  writes: ClipboardItem[][];
  rejectWith: (error: Error) => void;
}

interface ClipboardExecCommandMock {
  writes: Record<string, string>[];
}

interface BrowserDownload {
  readonly url: string;
  readonly filename: string;
  readonly blob: Blob | null;
}

interface BrowserDownloadMock {
  readonly blobForUrl: (url: string) => Blob | null;
  readonly downloads: BrowserDownload[];
  readonly revokedUrls: string[];
}

interface BrowserServiceWorkerMock {
  readonly dispatchMessage: (data: unknown) => void;
}

interface BrowserMatchMediaMock {
  readonly setMatches: (
    matches: boolean | ((query: string) => boolean),
  ) => void;
}

type BrowserElementRectResolver = (element: Element) => DOMRectInit | undefined;

interface ImageDimensionsMockValue {
  width: number;
  height: number;
}

type ImageDimensionsMockResult = ImageDimensionsMockValue | null;

interface ImageDimensionsMock {
  readonly createdUrls: string[];
  readonly revokedUrls: string[];
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
  let originalBrowserUrl: string | null = null;
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
      agents: (...args: Parameters<typeof setMockAgents>) => {
        setMockAgents(...args);
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
      url: (url: string): void => {
        if (originalBrowserUrl === null) {
          originalBrowserUrl = window.location.href;
          restoreOnAbort(getSignal(), () => {
            if (originalBrowserUrl !== null) {
              window.location.href = originalBrowserUrl;
              originalBrowserUrl = null;
            }
          });
        }
        window.location.href = url;
      },
      open: (openedWindow: Window | null = null): BrowserOpenMock => {
        return mockWindowOpen(openedWindow);
      },
      locationAssign: (): LocationAssignMock => {
        return mockLocationAssign();
      },
      authWindow: (): MockWindow => {
        return createMockWindow();
      },
      matchMedia: (
        matches: boolean | ((query: string) => boolean),
      ): BrowserMatchMediaMock => {
        return mockMatchMedia(matches);
      },
      boundingClientRect: (resolve: BrowserElementRectResolver): void => {
        mockBoundingClientRect(getSignal(), resolve);
      },
      standaloneDisplayMode: (enabled: boolean): void => {
        mockMatchMedia((query) => {
          return query === "(display-mode: standalone)" ? enabled : false;
        });
      },
      serviceWorker: (): BrowserServiceWorkerMock => {
        return mockServiceWorker(getSignal());
      },
      userAgent: (ua: string): void => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
      },
      fedCm: (options: BrowserFedCmOptions = {}): void => {
        const secureContextDescriptor = defineWindowProperty(
          window,
          "isSecureContext",
          options.secureContext ?? true,
        );
        const credentialsDescriptor = defineWindowProperty(
          navigator,
          "credentials",
          options.credentials === false
            ? undefined
            : {
                get: () => {
                  return Promise.resolve(null);
                },
              },
        );
        const identityCredentialDescriptor = defineWindowProperty(
          window,
          "IdentityCredential",
          options.identityCredential === false
            ? undefined
            : class TestIdentityCredential {},
        );
        restoreOnAbort(getSignal(), () => {
          restoreWindowProperty(
            window,
            "isSecureContext",
            secureContextDescriptor,
          );
          restoreWindowProperty(
            navigator,
            "credentials",
            credentialsDescriptor,
          );
          restoreWindowProperty(
            window,
            "IdentityCredential",
            identityCredentialDescriptor,
          );
        });
      },
      webAuthn: (options: BrowserWebAuthnOptions = {}): void => {
        const platformAuthenticatorResult = options.platformAuthenticatorResult;
        const secureContextDescriptor = defineWindowProperty(
          window,
          "isSecureContext",
          options.secureContext ?? true,
        );
        const credentialsDescriptor = defineWindowProperty(
          navigator,
          "credentials",
          options.credentials === false
            ? undefined
            : {
                get: () => {
                  return Promise.resolve(null);
                },
              },
        );
        const publicKeyCredential =
          options.publicKeyCredential === false
            ? undefined
            : platformAuthenticatorResult === undefined
              ? class TestPublicKeyCredential {}
              : class TestPublicKeyCredential {
                  static isUserVerifyingPlatformAuthenticatorAvailable(): Promise<boolean> {
                    return platformAuthenticatorResult === "error"
                      ? Promise.reject(
                          new Error("Platform authenticator check failed"),
                        )
                      : Promise.resolve(platformAuthenticatorResult);
                  }
                };
        const publicKeyCredentialDescriptor = defineWindowProperty(
          window,
          "PublicKeyCredential",
          publicKeyCredential,
        );
        restoreOnAbort(getSignal(), () => {
          restoreWindowProperty(
            window,
            "isSecureContext",
            secureContextDescriptor,
          );
          restoreWindowProperty(
            navigator,
            "credentials",
            credentialsDescriptor,
          );
          restoreWindowProperty(
            window,
            "PublicKeyCredential",
            publicKeyCredentialDescriptor,
          );
        });
      },
      platform: (platform: string): void => {
        vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      },
      maxTouchPoints: (maxTouchPoints: number): void => {
        vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(
          maxTouchPoints,
        );
      },
      screen: (options: BrowserScreenOptions): void => {
        mockScreen(getSignal(), options);
      },
      language: (language: string): void => {
        vi.spyOn(navigator, "language", "get").mockReturnValue(language);
      },
      visibilityState: (visibilityState: DocumentVisibilityState): void => {
        const descriptor = defineWindowProperty(
          document,
          "visibilityState",
          visibilityState,
        );
        restoreOnAbort(getSignal(), () => {
          restoreWindowProperty(document, "visibilityState", descriptor);
        });
      },
      cookie: (cookie: string): void => {
        vi.spyOn(document, "cookie", "get").mockReturnValue(cookie);
      },
      localStorageWrites: (): StorageWriteMock => {
        return mockLocalStorageWrites();
      },
      clipboardWriteText: (): ClipboardWriteMock => {
        return mockClipboardWriteText();
      },
      clipboardWrite: (): ClipboardRichWriteMock => {
        return mockClipboardWrite();
      },
      clipboardExecCommand: (): ClipboardExecCommandMock => {
        return mockClipboardExecCommand(getSignal());
      },
      blobDownload: (): BrowserDownloadMock => {
        return mockBlobDownload(getSignal());
      },
      audioContext: (): void => {
        mockAudioContext(getSignal());
      },
      voiceInput: (options?: VoiceInputMockOptions): void => {
        mockVoiceInput(getSignal(), options);
      },
      imageDimensions: (
        results:
          | ImageDimensionsMockResult
          | readonly ImageDimensionsMockResult[],
      ): ImageDimensionsMock => {
        return mockImageDimensions(getSignal(), results);
      },
      canvasRendering: (): CanvasRenderingMock => {
        return mockCanvasRendering(getSignal());
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
      deferNextSubscribe: () => {
        return deferNextAblySubscribe(getSignal());
      },
      trigger: triggerAblyEvent,
      triggerOnChannel: triggerAblyChannelEvent,
      triggerConnectionState: triggerAblyConnectionState,
      triggerFailure: triggerAblyFailure,
      triggerReconnect: triggerAblyReconnect,
      triggerSharedWorkerConnectionState:
        triggerSharedWorkerAblyConnectionState,
      triggerSharedWorkerFailure: triggerSharedWorkerAblyFailure,
      triggerSharedWorkerReconnect: triggerSharedWorkerAblyReconnect,
      triggerReauth: triggerAblyReauth,
      triggerConnectionClosed: triggerAblyConnectionClosed,
      rejectSubscribe: (topic: string, message: string) => {
        return rejectAblySubscribe(topic, message, getSignal());
      },
      rejectNextSubscribe: rejectNextAblySubscribe,
      hasChannelSubscription,
      hasChannelSubscriptionOnChannel,
      hasSubscription,
      hasSubscriptionOnChannel,
      getAuthTokenHistory,
    },
    deferred: <T>() => {
      return createDeferredPromise<T>(getSignal());
    },
  };
}

export type TestMocks = ReturnType<typeof createTestMocks>;

function mockWindowOpen(openedWindow: Window | null): BrowserOpenMock {
  const calls: WindowOpenCall[] = [];
  vi.spyOn(window, "open").mockImplementation((url, target, features) => {
    calls.push({
      url: url === undefined ? null : String(url),
      target: target === undefined ? null : target,
      features: features === undefined ? null : features,
    });
    return openedWindow;
  });
  return { calls, openedWindow };
}

function mockLocationAssign(): LocationAssignMock {
  const calls: string[] = [];
  vi.spyOn(window.location, "assign").mockImplementation((url) => {
    calls.push(String(url));
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

function mockLocalStorageWrites(): StorageWriteMock {
  const writes: StorageWrite[] = [];
  const storage = globalThis["localStorage"];
  const setItem = storage.setItem.bind(storage);
  vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
    writes.push({ key, value });
    setItem(key, value);
  });
  return { writes };
}

function mockMatchMedia(
  initialMatches: boolean | ((query: string) => boolean),
): BrowserMatchMediaMock {
  let resolveMatches = (query: string): boolean => {
    return typeof initialMatches === "function"
      ? initialMatches(query)
      : initialMatches;
  };
  const entries = new Set<{
    readonly query: string;
    readonly update: (matches: boolean) => void;
  }>();

  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    let currentMatches = resolveMatches(query);
    const eventTarget = new EventTarget();
    const mediaQueryList: MediaQueryList = {
      get matches() {
        return currentMatches;
      },
      media: query,
      onchange: null,
      addListener: vi.fn<MediaQueryList["addListener"]>(),
      removeListener: vi.fn<MediaQueryList["removeListener"]>(),
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    };
    entries.add({
      query,
      update(matches) {
        if (matches === currentMatches) {
          return;
        }
        currentMatches = matches;
        const event = new MediaQueryListEvent("change", {
          matches,
          media: query,
        });
        mediaQueryList.dispatchEvent(event);
        mediaQueryList.onchange?.call(mediaQueryList, event);
      },
    });
    return mediaQueryList;
  });

  return {
    setMatches(matches) {
      resolveMatches = (query: string): boolean => {
        return typeof matches === "function" ? matches(query) : matches;
      };
      for (const entry of entries) {
        entry.update(resolveMatches(entry.query));
      }
    },
  };
}

function mockBoundingClientRect(
  signal: AbortSignal,
  resolve: BrowserElementRectResolver,
): void {
  const getBoundingClientRect = Element.prototype.getBoundingClientRect;
  const spy = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function getMockBoundingClientRect(this: Element) {
      const rect = resolve(this);
      return rect === undefined
        ? getBoundingClientRect.call(this)
        : DOMRect.fromRect(rect);
    });

  restoreOnAbort(signal, () => {
    spy.mockRestore();
  });
}

function mockServiceWorker(signal: AbortSignal): BrowserServiceWorkerMock {
  const serviceWorker = new EventTarget();
  const descriptor = defineWindowProperty(
    navigator,
    "serviceWorker",
    serviceWorker,
  );
  restoreOnAbort(signal, () => {
    restoreWindowProperty(navigator, "serviceWorker", descriptor);
  });

  return {
    dispatchMessage(data: unknown): void {
      serviceWorker.dispatchEvent(new MessageEvent("message", { data }));
    },
  };
}

function mockClipboardWriteText(): ClipboardWriteMock {
  const writes: string[] = [];
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation((text) => {
    writes.push(text);
    return Promise.resolve();
  });
  return { writes };
}

function mockClipboardWrite(): ClipboardRichWriteMock {
  const writes: ClipboardItem[][] = [];
  let rejection: Error | null = null;
  vi.spyOn(navigator.clipboard, "write").mockImplementation((items) => {
    writes.push(items);
    if (rejection !== null) {
      return Promise.reject(new Error(rejection.message, { cause: rejection }));
    }
    return Promise.resolve();
  });
  return {
    writes,
    rejectWith(error: Error) {
      rejection = error;
    },
  };
}

function mockClipboardExecCommand(
  signal: AbortSignal,
): ClipboardExecCommandMock {
  const writes: Record<string, string>[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: (command: string) => {
      if (command !== "copy") {
        return false;
      }
      if (document.getSelection()?.rangeCount === 0) {
        return false;
      }
      const data: Record<string, string> = {};
      const event = new Event("copy", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "clipboardData", {
        value: {
          setData(type: string, value: string) {
            data[type] = value;
          },
        },
      });
      const handled = !document.dispatchEvent(event);
      if (handled) {
        writes.push(data);
      }
      return handled;
    },
  });
  restoreOnAbort(signal, () => {
    if (descriptor) {
      Object.defineProperty(document, "execCommand", descriptor);
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
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
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({
      url: this.href,
      filename: this.download,
      blob: blobs.get(this.href) ?? null,
    });
  });

  restoreOnAbort(signal, () => {
    restoreWindowProperty(URL, "createObjectURL", createObjectUrlDescriptor);
    restoreWindowProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
  });

  return {
    blobForUrl: (url) => {
      return blobs.get(url) ?? null;
    },
    downloads,
    revokedUrls,
  };
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

interface VoiceInputMockOptions {
  readonly audioContextReady?: Promise<void>;
  readonly durationSeconds?: number;
  readonly getUserMediaReady?: Promise<void>;
  readonly onRecorderStart?: () => void;
  readonly onRecorderStop?: () => void;
  readonly rms?: number | readonly number[] | (() => number);
}

function mockVoiceInput(
  signal: AbortSignal,
  options: VoiceInputMockOptions = {},
): void {
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

  class TestMediaStreamAudioSource {
    connect(_destination: AnalyserNode): void {}

    disconnect(): void {}
  }

  let sampleIndex = 0;
  let recordingChunkIndex = 0;

  function nextRms(): number {
    const rms = options.rms;
    if (typeof rms === "function") {
      return rms();
    }
    if (typeof rms === "number") {
      return rms;
    }
    if (rms) {
      const index = Math.min(sampleIndex, rms.length - 1);
      sampleIndex += 1;
      return rms[index] ?? 0;
    }
    return 0;
  }

  function nextRecordingBlob(mimeType: string, standalone: boolean): Blob {
    recordingChunkIndex += 1;
    const prefix = standalone ? "voice" : "chunk";
    const value = `${prefix}-${recordingChunkIndex}`;
    const blob = new Blob([value], { type: mimeType });
    if (typeof blob.arrayBuffer !== "function") {
      Object.defineProperty(blob, "arrayBuffer", {
        value: (): Promise<ArrayBuffer> => {
          return Promise.resolve(new TextEncoder().encode(value).buffer);
        },
      });
    }
    return blob;
  }

  class TestAnalyser {
    fftSize = 1024;

    getFloatTimeDomainData(samples: Float32Array<ArrayBuffer>): void {
      samples.fill(nextRms());
    }

    disconnect(): void {}
  }

  class TestVoiceAudioContext {
    resume(): Promise<void> {
      return options.audioContextReady ?? Promise.resolve();
    }

    close(): Promise<void> {
      return Promise.resolve();
    }

    createMediaStreamSource(_stream: MediaStream): MediaStreamAudioSourceNode {
      return new TestMediaStreamAudioSource() as unknown as MediaStreamAudioSourceNode;
    }

    createAnalyser(): AnalyserNode {
      return new TestAnalyser() as unknown as AnalyserNode;
    }

    decodeAudioData(_audioData: ArrayBuffer): Promise<AudioBuffer> {
      const length = Math.round(
        16_000 *
          (options.durationSeconds === undefined ? 1 : options.durationSeconds),
      );
      const samples = new Float32Array(length);
      samples.fill(0.1);
      return Promise.resolve({
        duration: length / 16_000,
        length,
        numberOfChannels: 1,
        sampleRate: 16_000,
        getChannelData: () => {
          return samples;
        },
      } as unknown as AudioBuffer);
    }
  }

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
      options.onRecorderStart?.();
    }

    requestData(): void {
      if (this.state !== "recording") {
        return;
      }
      this.emitData(false);
    }

    private emitData(standalone: boolean): void {
      const event = new Event("dataavailable") as RecorderDataEvent;
      Object.defineProperty(event, "data", {
        value: nextRecordingBlob(this.mimeType, standalone),
      });
      this.ondataavailable?.(event);
      this.dispatchEvent(event);
    }

    stop(): void {
      if (this.state === "inactive") {
        return;
      }
      this.state = "inactive";
      this.emitData(true);
      this.dispatchEvent(new Event("stop"));
      options.onRecorderStop?.();
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
        return (options.getUserMediaReady ?? Promise.resolve()).then(() => {
          return stream;
        });
      },
    },
  );
  const mediaRecorderDescriptor = defineWindowProperty(
    mediaRecorderGlobal,
    "MediaRecorder",
    TestMediaRecorder as unknown as typeof MediaRecorder,
  );
  const audioContextDescriptor =
    options.rms === undefined
      ? undefined
      : defineWindowProperty(
          window,
          "AudioContext",
          TestVoiceAudioContext as unknown as typeof AudioContext,
        );

  restoreOnAbort(signal, () => {
    restoreWindowProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
    restoreWindowProperty(
      mediaRecorderGlobal,
      "MediaRecorder",
      mediaRecorderDescriptor,
    );
    if (audioContextDescriptor !== undefined) {
      restoreWindowProperty(window, "AudioContext", audioContextDescriptor);
    }
  });
}

function mockImageDimensions(
  signal: AbortSignal,
  results: ImageDimensionsMockResult | readonly ImageDimensionsMockResult[],
): ImageDimensionsMock {
  const pendingResults = Array.isArray(results) ? [...results] : [results];
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
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
      const url = `blob:mock-image-${objectUrlIndex}`;
      createdUrls.push(url);
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

  return { createdUrls, revokedUrls };
}

function mockScreen(signal: AbortSignal, options: BrowserScreenOptions): void {
  const widthDescriptor = defineWindowProperty(screen, "width", options.width);
  const heightDescriptor = defineWindowProperty(
    screen,
    "height",
    options.height,
  );
  const pixelRatioDescriptor = defineWindowProperty(
    window,
    "devicePixelRatio",
    options.pixelRatio,
  );

  restoreOnAbort(signal, () => {
    restoreWindowProperty(screen, "width", widthDescriptor);
    restoreWindowProperty(screen, "height", heightDescriptor);
    restoreWindowProperty(window, "devicePixelRatio", pixelRatioDescriptor);
  });
}

function mockCanvasRendering(signal: AbortSignal): CanvasRenderingMock {
  const renders: CanvasRender[] = [];
  let avatarHeight = 0;
  let avatarWidth = 0;
  let avatarX = 0;
  let avatarY = 0;
  const context = {
    fillStyle: "",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    drawImage(
      _image: CanvasImageSource,
      x: number,
      y: number,
      width: number,
      height: number,
    ) {
      avatarX = x;
      avatarY = y;
      avatarWidth = width;
      avatarHeight = height;
    },
    fillRect() {},
  } as unknown as CanvasRenderingContext2D;

  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(function getContext(contextId: string) {
      return contextId === "2d" ? context : null;
    } as typeof HTMLCanvasElement.prototype.getContext);
  const toDataURL = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockImplementation(function toDataURL(this: HTMLCanvasElement) {
      renders.push({
        avatar: {
          height: avatarHeight,
          width: avatarWidth,
          x: avatarX,
          y: avatarY,
        },
        background: String(context.fillStyle),
        height: this.height,
        width: this.width,
      });
      return renders.length === 1
        ? "data:image/png;base64,AAAA"
        : "data:image/png;base64,AAAB";
    });

  restoreOnAbort(signal, () => {
    getContext.mockRestore();
    toDataURL.mockRestore();
  });

  return { renders };
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
