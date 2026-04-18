import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { FeatureSwitchKey } from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

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
    http.post("*/api/zero/voice-io/stt", () => {
      return HttpResponse.json({ text });
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
      featureSwitches: { [FeatureSwitchKey.AudioIO]: false },
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
      featureSwitches: { [FeatureSwitchKey.AudioIO]: true },
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
      featureSwitches: { [FeatureSwitchKey.AudioIO]: true },
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
    vi.unstubAllGlobals();
  });

  it("should show stop recording button after clicking voice input", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.AudioIO]: true },
    });

    const micButton = await waitFor(() => {
      return screen.getByLabelText("Voice input");
    });

    await user.click(micButton);

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
    vi.unstubAllGlobals();
  });

  it("should populate composer input with transcribed text without sending", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();

    const transcribedText = "hello from voice";
    mockSttEndpoint(transcribedText);

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.AudioIO]: true },
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    const micButton = await waitFor(() => {
      return screen.getByLabelText("Voice input");
    });

    await user.click(micButton);

    const stopButton = await waitFor(() => {
      return screen.getByLabelText("Stop recording");
    });

    await user.click(stopButton);

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
      featureSwitches: { [FeatureSwitchKey.AudioIO]: true },
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await user.type(textarea, "hello");

    const micButton = await waitFor(() => {
      return screen.getByLabelText("Voice input");
    });

    await user.click(micButton);

    const stopButton = await waitFor(() => {
      return screen.getByLabelText("Stop recording");
    });

    await user.click(stopButton);

    await waitFor(() => {
      expect(textarea.value).toBe(`hello ${transcribedText}`);
    });
  });
});
