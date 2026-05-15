import {
  LOCAL_BROWSER_EXTENSION_MESSAGE_SOURCE,
  isBridgeRequest,
  messageFromBridgeRequest,
  type BridgeBackgroundResponse,
} from "../shared/protocol";

function responseType(response: BridgeBackgroundResponse): string {
  if (!response.ok) {
    return "vm0.localBrowser.error";
  }
  if (response.type === "detected") {
    return "vm0.localBrowser.detected";
  }
  if (response.type === "pairingStarted") {
    return "vm0.localBrowser.pairingStarted";
  }
  return "vm0.localBrowser.error";
}

function postBridgeResponse(
  requestId: string,
  response: BridgeBackgroundResponse,
): void {
  window.postMessage(
    {
      source: LOCAL_BROWSER_EXTENSION_MESSAGE_SOURCE,
      type: responseType(response),
      requestId,
      ...(response.ok && response.type === "detected"
        ? {
            browser: response.browser,
            extensionVersion: response.extensionVersion,
          }
        : {}),
      ...(response.ok && response.type === "pairingStarted"
        ? {
            deviceCode: response.deviceCode,
            userCode: response.userCode,
          }
        : {}),
      ...(!response.ok ? { message: response.message } : {}),
    },
    window.location.origin,
  );
}

async function sendToBackground(
  message: ReturnType<typeof messageFromBridgeRequest>,
): Promise<BridgeBackgroundResponse> {
  const response = await chrome.runtime.sendMessage(message);
  if (typeof response === "object" && response !== null && "ok" in response) {
    return response as BridgeBackgroundResponse;
  }
  return {
    message: "Local browser extension returned an invalid response",
    ok: false,
  };
}

function handleWindowMessage(event: MessageEvent<unknown>): void {
  if (event.source !== window) {
    return;
  }
  if (event.origin !== window.location.origin) {
    return;
  }
  if (!isBridgeRequest(event.data)) {
    return;
  }

  const request = event.data;
  void sendToBackground(messageFromBridgeRequest(request, window.location.href))
    .then((response) => {
      postBridgeResponse(request.requestId, response);
    })
    .catch((error: unknown) => {
      postBridgeResponse(request.requestId, {
        message:
          error instanceof Error
            ? error.message
            : "Local browser extension failed",
        ok: false,
      });
    });
}

window.addEventListener("message", handleWindowMessage);
