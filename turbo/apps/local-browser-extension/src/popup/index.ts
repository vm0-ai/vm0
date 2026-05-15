import type {
  BridgeBackgroundMessage,
  BridgeBackgroundResponse,
  ExtensionStatus,
} from "../shared/protocol";

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing popup element: ${id}`);
  }
  return element;
}

function getButton(id: string): HTMLButtonElement {
  const element = getElement(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Popup element is not a button: ${id}`);
  }
  return element;
}

async function sendMessage(
  message: BridgeBackgroundMessage,
): Promise<BridgeBackgroundResponse> {
  const response = await chrome.runtime.sendMessage(message);
  if (typeof response === "object" && response !== null && "ok" in response) {
    return response as BridgeBackgroundResponse;
  }
  return {
    message: "Extension runtime returned an invalid response",
    ok: false,
  };
}

function formatDate(value: number | undefined): string {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function renderStatus(status: ExtensionStatus): void {
  const subtitle = getElement("subtitle");
  const dot = getElement("status-dot");
  const hostName = getElement("host-name");
  const apiBase = getElement("api-base");
  const heartbeat = getElement("heartbeat");
  const errorRow = getElement("error-row");
  const lastError = getElement("last-error");
  const revoke = getButton("revoke");

  dot.className = "dot";
  if (status.linked) {
    dot.classList.add("online");
    subtitle.textContent = status.paused ? "Connected, paused" : "Connected";
  } else if (status.paired) {
    dot.classList.add("pending");
    subtitle.textContent = "Pairing in progress";
  } else {
    subtitle.textContent = "Not paired";
  }

  hostName.textContent = status.hostName ?? "Not paired";
  apiBase.textContent = status.apiBaseUrl ?? "-";
  heartbeat.textContent = formatDate(status.lastHeartbeatAt);
  revoke.disabled = !status.linked && !status.paired;

  if (status.lastError) {
    errorRow.hidden = false;
    lastError.textContent = status.lastError;
  } else {
    errorRow.hidden = true;
    lastError.textContent = "-";
  }
}

async function refresh(): Promise<void> {
  const response = await sendMessage({ type: "localBrowser.getStatus" });
  if (!response.ok || response.type !== "status") {
    throw new Error(
      response.ok ? "Unexpected status response" : response.message,
    );
  }
  renderStatus(response.status);
}

function bindActions(): void {
  getButton("open-connectors").addEventListener("click", () => {
    void sendMessage({ type: "localBrowser.openConnectorPage" });
  });
  getButton("revoke").addEventListener("click", async () => {
    const revoke = getButton("revoke");
    revoke.disabled = true;
    await sendMessage({ type: "localBrowser.revokeHost" });
    await refresh();
  });
}

bindActions();
void refresh().catch((error: unknown) => {
  renderStatus({
    lastError: error instanceof Error ? error.message : "Failed to load status",
    linked: false,
    paired: false,
    paused: false,
  });
});
