import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { zeroVoiceIoQuotaContract } from "@vm0/api-contracts/contracts/zero-voice-io-quota";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { server } from "../../../mocks/server.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const CHAT_PATH = `/agents/${AGENT_ID}/chat`;

// ---------------------------------------------------------------------------
// Browser API stubs
// ---------------------------------------------------------------------------

function stubMediaDevices() {
  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks() {
          return [{ stop: vi.fn() }];
        },
      }),
    },
    writable: true,
    configurable: true,
  });
}

function clearMediaDevices() {
  Object.defineProperty(navigator, "mediaDevices", {
    value: undefined,
    writable: true,
    configurable: true,
  });
}

function mockSttEndpoint(text = "transcribed text") {
  server.use(
    // mockApi cannot be used here: /api/zero/voice-io/stt has no ts-rest contract
    // (accepts multipart FormData audio body), so raw http is the only option.
    http.post("*/api/zero/voice-io/stt", () => {
      return HttpResponse.json({ text });
    }),
  );
}

function mockSttQuotaExceededEndpoint() {
  server.use(
    // mockApi cannot be used here: /api/zero/voice-io/stt has no ts-rest contract
    // (accepts multipart FormData audio body), so raw http is the only option.
    http.post("*/api/zero/voice-io/stt", () => {
      return HttpResponse.json(
        {
          error: {
            message: "Audio input quota exceeded",
            code: "AUDIO_INPUT_QUOTA_EXCEEDED",
          },
          quota: { count: 3, limit: 3 },
        },
        { status: 402 },
      );
    }),
  );
}

function mockQuotaEndpoint(quota: {
  allowed: boolean;
  count: number;
  limit: number | null;
}) {
  server.use(
    mockApi(zeroVoiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, quota);
    }),
  );
}

// ---------------------------------------------------------------------------
// MediaRecorder mock
// ---------------------------------------------------------------------------

type DataHandler = (event: { data: Blob }) => void;
type StopHandler = () => void;

function stubMediaRecorder() {
  let onDataCallback: DataHandler | null = null;
  let onStopCallback: StopHandler | null = null;

  class MockMediaRecorder {
    mimeType: string;
    state: string;

    private _ondataavailable: DataHandler | null = null;

    get ondataavailable() {
      return this._ondataavailable;
    }
    set ondataavailable(fn: DataHandler | null) {
      onDataCallback = fn;
      this._ondataavailable = fn;
    }

    constructor(_stream: MediaStream, opts?: { mimeType?: string }) {
      this.mimeType = opts?.mimeType ?? "audio/webm";
      this.state = "inactive";
    }

    start() {
      this.state = "recording";
    }

    stop() {
      this.state = "inactive";
      if (onDataCallback) {
        onDataCallback({
          data: new Blob(["fake-audio"], { type: "audio/webm" }),
        });
      }
      if (onStopCallback) {
        onStopCallback();
      }
    }

    addEventListener(event: string, callback: StopHandler, _opts?: unknown) {
      if (event === "stop") {
        onStopCallback = callback;
      }
    }

    static isTypeSupported(type: string) {
      return type === "audio/webm";
    }
  }

  vi.stubGlobal("MediaRecorder", MockMediaRecorder);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("chat-d-032: mic button visibility with feature switch", () => {
  beforeEach(() => {
    stubMediaDevices();
  });

  afterEach(() => {
    clearMediaDevices();
  });

  it("should not render mic button when VoiceIO feature switch is off", async () => {
    mockChatLifecycle();

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.AudioInput]: false },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("Voice input")).not.toBeInTheDocument();
  });

  it("should render mic button when VoiceIO feature switch is on and browser supports getUserMedia", async () => {
    mockChatLifecycle();

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.AudioInput]: true },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Voice input")).toBeInTheDocument();
    });
  });

  it("should not render mic button when browser does not support getUserMedia", async () => {
    clearMediaDevices();
    mockChatLifecycle();

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.AudioInput]: true },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("Voice input")).not.toBeInTheDocument();
  });
});

describe("chat-i-033: mic button recording interaction", () => {
  beforeEach(() => {
    stubMediaDevices();
    stubMediaRecorder();
    mockSttEndpoint();
  });

  afterEach(() => {
    clearMediaDevices();
  });

  it("should show stop recording button after clicking voice input", async () => {
    mockChatLifecycle();

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.AudioInput]: true },
    });

    const micButton = await waitFor(() => {
      return screen.getByLabelText("Voice input");
    });

    click(micButton);

    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });
  });
});

describe("chat-i-034: mic button transcription appends to draft", () => {
  beforeEach(() => {
    stubMediaDevices();
    stubMediaRecorder();
  });

  afterEach(() => {
    clearMediaDevices();
  });

  it("should populate composer input with transcribed text without sending", async () => {
    mockChatLifecycle();

    const transcribedText = "hello from voice";
    mockSttEndpoint(transcribedText);

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.AudioInput]: true },
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    const micButton = await waitFor(() => {
      return screen.getByLabelText("Voice input");
    });

    click(micButton);

    const stopButton = await waitFor(() => {
      return screen.getByLabelText("Stop recording");
    });

    click(stopButton);

    await waitFor(() => {
      expect(textarea.value).toBe(transcribedText);
    });

    // Send button is present (not replaced by Stop), meaning no auto-send happened.
    expect(screen.getByLabelText("Send")).toBeInTheDocument();
    expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
  });

  it("should append transcribed text to existing draft with a space separator", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();

    const transcribedText = "from voice";
    mockSttEndpoint(transcribedText);

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.AudioInput]: true },
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await user.type(textarea, "hello");

    const micButton = await waitFor(() => {
      return screen.getByLabelText("Voice input");
    });

    click(micButton);

    const stopButton = await waitFor(() => {
      return screen.getByLabelText("Stop recording");
    });

    click(stopButton);

    await waitFor(() => {
      expect(textarea.value).toBe(`hello ${transcribedText}`);
    });
  });
});

describe("chat-i-035: mic button gates on audio input quota", () => {
  beforeEach(() => {
    stubMediaDevices();
    stubMediaRecorder();
  });

  afterEach(() => {
    clearMediaDevices();
  });

  it("should start recording when quota is available", async () => {
    mockChatLifecycle();
    mockQuotaEndpoint({ allowed: true, count: 1, limit: 3 });
    mockSttEndpoint();

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.AudioInput]: true },
    });

    const micButton = await waitFor(() => {
      return screen.getByLabelText("Voice input");
    });

    click(micButton);

    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });
    expect(screen.queryByText("Compare plans")).not.toBeInTheDocument();
  });

  it("should open billing dialog without recording when quota is exhausted", async () => {
    mockChatLifecycle();
    mockQuotaEndpoint({ allowed: false, count: 3, limit: 3 });

    let sttCalls = 0;
    server.use(
      // mockApi cannot be used here: /api/zero/voice-io/stt has no ts-rest contract
      // (accepts multipart FormData audio body), so raw http is the only option.
      http.post("*/api/zero/voice-io/stt", () => {
        sttCalls++;
        return HttpResponse.json({ text: "should-not-be-called" });
      }),
    );

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.AudioInput]: true },
    });

    const micButton = await waitFor(() => {
      return screen.getByLabelText("Voice input");
    });

    click(micButton);

    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("Stop recording")).not.toBeInTheDocument();
    expect(sttCalls).toBe(0);
  });

  it("should open billing dialog when STT returns 402 quota-exceeded after recording", async () => {
    mockChatLifecycle();
    mockQuotaEndpoint({ allowed: true, count: 2, limit: 3 });
    mockSttQuotaExceededEndpoint();

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.AudioInput]: true },
    });

    const micButton = await waitFor(() => {
      return screen.getByLabelText("Voice input");
    });

    click(micButton);

    const stopButton = await waitFor(() => {
      return screen.getByLabelText("Stop recording");
    });

    click(stopButton);

    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
    });
  });
});
