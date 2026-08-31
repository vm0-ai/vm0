import {
  isOkouAppUrl,
  isOkouRecorderPageMessage,
  OKOU_RECORDER_CHANNEL,
  OKOU_RECORDER_PROTOCOL_VERSION,
  okouRecorderSessionId,
  type OkouRecorderPageMessage,
} from "@okouai/core/browser-recorder-protocol";

import {
  extensionMessage,
  isRuntimeMessage,
  type ContentMessage,
  type WorkerMessage,
} from "./messages.ts";
import { RecorderOverlay } from "./overlay.ts";

let overlay: RecorderOverlay | null = null;
let sessionId: string | null = null;

function notifyWorker(message: WorkerMessage): void {
  void chrome.runtime.sendMessage(message);
}

function sendCommand(
  action: Extract<
    WorkerMessage,
    { readonly type: "content:command" }
  >["action"],
): void {
  if (!sessionId) {
    return;
  }
  notifyWorker(
    extensionMessage({
      action,
      recipient: "worker",
      sessionId,
      type: "content:command",
    }),
  );
}

function ensureOverlay(): RecorderOverlay {
  if (overlay) {
    return overlay;
  }
  overlay = new RecorderOverlay({
    onCancel: () => {
      sendCommand("cancel");
    },
    onFinish: () => {
      sendCommand("finish");
    },
    onMicrophone: (enabled) => {
      if (!sessionId) {
        return;
      }
      notifyWorker(
        extensionMessage({
          enabled,
          recipient: "worker",
          sessionId,
          type: "content:microphone",
        }),
      );
    },
    onPause: () => {
      sendCommand("pause");
    },
    onResume: () => {
      sendCommand("resume");
    },
    onStart: () => {
      sendCommand("start");
    },
  });
  return overlay;
}

function teardownOverlay(): void {
  overlay?.destroy();
  overlay = null;
  sessionId = null;
}

function handleContentMessage(message: ContentMessage): void {
  switch (message.type) {
    case "worker:prepare": {
      sessionId = message.sessionId;
      ensureOverlay().prepare(message.state);
      break;
    }
    case "worker:state": {
      if (message.sessionId === sessionId) {
        ensureOverlay().update(message.state);
      }
      break;
    }
    case "worker:error": {
      if (message.sessionId === sessionId) {
        ensureOverlay().showError(message.code);
      }
      break;
    }
    case "worker:cleanup": {
      if (message.sessionId === sessionId) {
        teardownOverlay();
      }
      break;
    }
  }
}

chrome.runtime.onMessage.addListener((value, _sender, sendResponse) => {
  if (!isRuntimeMessage(value) || value.recipient !== "content") {
    return false;
  }
  handleContentMessage(value);
  sendResponse({ ok: true });
  return false;
});

// A navigation inside the recorded tab destroys the overlay, so ask the worker
// to re-send the live session state as soon as the new document loads.
notifyWorker(
  extensionMessage({
    recipient: "worker",
    type: "content:mounted",
  }),
);

/**
 * Bridges the finished recording from the extension into the Okou application.
 *
 * The recording lives in the extension's own IndexedDB, which page scripts
 * cannot read. `handoff.html` is loaded as a hidden extension-origin iframe;
 * this content script relays its structured-clone messages to the application
 * and relays the application's acknowledgement back so the extension copy is
 * deleted.
 */
function startHandoff(handoffSessionId: string): void {
  const frame = document.createElement("iframe");
  frame.src = `${chrome.runtime.getURL("handoff.html")}#${handoffSessionId}`;
  frame.setAttribute("aria-hidden", "true");
  frame.style.display = "none";

  let frameLoaded = false;
  let pendingReady = false;

  const toFrame = (message: OkouRecorderPageMessage): void => {
    frame.contentWindow?.postMessage(message, "*");
  };

  frame.addEventListener("load", () => {
    frameLoaded = true;
    if (pendingReady) {
      toFrame({
        channel: OKOU_RECORDER_CHANNEL,
        sessionId: handoffSessionId,
        source: "platform",
        type: "handoff:ready",
        version: OKOU_RECORDER_PROTOCOL_VERSION,
      });
    }
  });

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message: unknown = event.data;
    if (
      !isOkouRecorderPageMessage(message) ||
      ("sessionId" in message && message.sessionId !== handoffSessionId)
    ) {
      return;
    }
    if (event.source === frame.contentWindow) {
      if (
        message.type === "handoff:recording" ||
        message.type === "handoff:error"
      ) {
        window.postMessage(message, location.origin);
      }
      return;
    }
    if (event.source !== window || message.source !== "platform") {
      return;
    }
    if (message.type === "handoff:ready") {
      pendingReady = true;
      if (frameLoaded) {
        toFrame(message);
      }
      return;
    }
    if (message.type === "handoff:complete") {
      toFrame(message);
      frame.remove();
    }
  });

  document.documentElement.append(frame);
}

if (isOkouAppUrl(location.href)) {
  const handoffSessionId = okouRecorderSessionId(new URL(location.href));
  if (handoffSessionId) {
    startHandoff(handoffSessionId);
  }
}
