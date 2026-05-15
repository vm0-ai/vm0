import type {
  BridgeBackgroundMessage,
  BridgeBackgroundResponse,
} from "../shared/protocol";
import {
  detectExtension,
  extensionStatus,
  handleAlarm,
  initializeRuntime,
  openConnectorPage,
  revokeHost,
  startPairing,
} from "./runtime";

function isBackgroundMessage(value: unknown): value is BridgeBackgroundMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const type = (value as Record<string, unknown>).type;
  return (
    type === "localBrowser.detect" ||
    type === "localBrowser.pair" ||
    type === "localBrowser.getStatus" ||
    type === "localBrowser.revokeHost" ||
    type === "localBrowser.openConnectorPage"
  );
}

function errorResponse(error: unknown): BridgeBackgroundResponse {
  return {
    message:
      error instanceof Error ? error.message : "Local browser extension failed",
    ok: false,
  };
}

async function handleMessage(
  message: BridgeBackgroundMessage,
): Promise<BridgeBackgroundResponse> {
  switch (message.type) {
    case "localBrowser.detect":
      return await detectExtension();
    case "localBrowser.pair":
      return await startPairing(message.pageUrl);
    case "localBrowser.getStatus":
      return await extensionStatus();
    case "localBrowser.revokeHost":
      return await revokeHost();
    case "localBrowser.openConnectorPage":
      return await openConnectorPage();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isBackgroundMessage(message)) {
    return false;
  }

  void handleMessage(message)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse(errorResponse(error));
    });
  return true;
});

chrome.alarms.onAlarm.addListener(handleAlarm);
chrome.runtime.onInstalled.addListener(() => {
  void initializeRuntime();
});
chrome.runtime.onStartup.addListener(() => {
  void initializeRuntime();
});

void initializeRuntime();
