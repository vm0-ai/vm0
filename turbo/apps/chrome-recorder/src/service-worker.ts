import { OKOU_RECORDER_SESSION_QUERY } from "@okouai/core/browser-recorder-protocol";

import {
  extensionMessage,
  isCaptureSelection,
  isRuntimeMessage,
  type CaptureSelection,
  type ContentMessage,
  type OffscreenMessage,
  type RecorderStateSnapshot,
  type WorkerMessage,
} from "./messages.ts";

interface StoredSession {
  readonly appOrigin: string;
  readonly sessionId: string;
  readonly state: RecorderStateSnapshot;
  readonly targetTabId: number;
}

const ACTIVE_SESSION_KEY = "active-recorder-session";
const OKOU_APP_ORIGIN = "https://app.okou.ai";
// Checked in order so a local or preview sign-in wins over production while
// the feature is being developed against a non-production deployment.
const OKOU_APP_ORIGINS = [
  "http://localhost:3002",
  "https://staging-app.vm7.ai",
  OKOU_APP_ORIGIN,
] as const;

async function activeSession(): Promise<StoredSession | null> {
  const stored: unknown = await chrome.storage.session.get(ACTIVE_SESSION_KEY);
  const value = (stored as Readonly<Record<string, unknown>>)[
    ACTIVE_SESSION_KEY
  ];
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const session = value as Readonly<Record<string, unknown>>;
  if (
    typeof session.appOrigin !== "string" ||
    typeof session.sessionId !== "string" ||
    typeof session.targetTabId !== "number" ||
    typeof session.state !== "object" ||
    session.state === null
  ) {
    return null;
  }
  return value as StoredSession;
}

async function saveActiveSession(session: StoredSession): Promise<void> {
  await chrome.storage.session.set({ [ACTIVE_SESSION_KEY]: session });
}

async function clearActiveSession(): Promise<void> {
  await chrome.storage.session.remove(ACTIVE_SESSION_KEY);
  await chrome.action.setBadgeText({ text: "" });
}

async function ensureOffscreenDocument(): Promise<void> {
  const documentUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [documentUrl],
  });
  if (contexts.length > 0) {
    return;
  }
  await chrome.offscreen.createDocument({
    justification:
      "Keep the user-selected tab capture and MediaRecorder alive across navigation.",
    reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA],
    url: "offscreen.html",
  });
}

/**
 * Resolves the Okou deployment the user is currently signed in to.
 *
 * Clerk keeps a `__session` JWT and a `__client_uat` sign-in timestamp on the
 * application origin. Reading them through `chrome.cookies` verifies the login
 * before Chrome's share picker opens, and works with no Okou tab open.
 */
async function signedInAppOrigin(): Promise<string | null> {
  for (const origin of OKOU_APP_ORIGINS) {
    const session = await chrome.cookies.get({
      name: "__session",
      url: origin,
    });
    if (session && session.value.length > 0) {
      return origin;
    }
    const signedInAt = await chrome.cookies.get({
      name: "__client_uat",
      url: origin,
    });
    if (signedInAt && signedInAt.value !== "0") {
      return origin;
    }
  }
  return null;
}

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) {
    return;
  }
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== chrome.windows.WINDOW_ID_NONE) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

/**
 * Reports a dead end on the toolbar action.
 *
 * Recording is refused before any page controls exist, so the action badge is
 * the only surface left to explain why nothing happened.
 */
async function reportBlocked(title: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: "#ff4f0a" });
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setTitle({ title });
}

async function openLoginPreflight(): Promise<void> {
  await chrome.tabs.create({ active: true, url: `${OKOU_APP_ORIGIN}/` });
  await reportBlocked("Sign in to Okou, then click the recorder again");
}

async function selectCaptureSource(
  sessionId: string,
): Promise<CaptureSelection> {
  await ensureOffscreenDocument();
  const response: unknown = await chrome.runtime.sendMessage(
    extensionMessage({
      recipient: "offscreen",
      sessionId,
      type: "worker:select-source",
    }),
  );
  return isCaptureSelection(response)
    ? response
    : { ok: false, reason: "failed" };
}

function isInjectableTab(
  tab: chrome.tabs.Tab | undefined,
): tab is chrome.tabs.Tab & {
  readonly id: number;
  readonly url: string;
} {
  if (!tab?.id || !tab.url) {
    return false;
  }
  const url = new URL(tab.url);
  return url.protocol === "http:" || url.protocol === "https:";
}

async function sendToTarget(
  tabId: number,
  message: ContentMessage,
): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    return false;
  }
}

async function sendOffscreen(message: OffscreenMessage): Promise<void> {
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage(message);
}

async function cancelSession(session: StoredSession): Promise<void> {
  await sendOffscreen(
    extensionMessage({
      action: "cancel",
      recipient: "offscreen",
      sessionId: session.sessionId,
      type: "worker:command",
    }),
  );
  await sendToTarget(
    session.targetTabId,
    extensionMessage({
      recipient: "content",
      sessionId: session.sessionId,
      type: "worker:cleanup",
    }),
  );
  await clearActiveSession();
}

async function beginCapture(): Promise<void> {
  const existing = await activeSession();
  if (existing) {
    const target = await chrome.tabs.get(existing.targetTabId);
    await focusTab(target);
    return;
  }

  const appOrigin = await signedInAppOrigin();
  if (!appOrigin) {
    await openLoginPreflight();
    return;
  }

  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "Start an Okou recording" });
  const sessionId = crypto.randomUUID();
  const selection = await selectCaptureSource(sessionId);
  if (!selection.ok) {
    if (selection.reason === "tab-required") {
      await reportBlocked(
        "Okou records a Chrome tab. Choose the Chrome Tab option and pick a tab.",
      );
    }
    if (selection.reason === "failed") {
      await reportBlocked("Chrome could not start capturing this tab");
    }
    return;
  }

  const [target] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!isInjectableTab(target)) {
    await sendOffscreen(
      extensionMessage({
        action: "cancel",
        recipient: "offscreen",
        sessionId,
        type: "worker:command",
      }),
    );
    await reportBlocked(
      "Okou controls need a regular http or https tab, not a Chrome page",
    );
    return;
  }

  const state: RecorderStateSnapshot = {
    elapsedSeconds: 0,
    microphone: false,
    status: "ready",
    tabAudio: selection.tabAudio,
  };
  const session: StoredSession = {
    appOrigin,
    sessionId,
    state,
    targetTabId: target.id,
  };
  await saveActiveSession(session);
  const prepared = await sendToTarget(
    target.id,
    extensionMessage({
      recipient: "content",
      sessionId,
      state,
      type: "worker:prepare",
    }),
  );
  if (!prepared) {
    await cancelSession(session);
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  await chrome.action.setBadgeText({ text: "REC" });
}

async function handleContentMessage(
  message: Extract<
    WorkerMessage,
    { readonly type: "content:command" | "content:microphone" }
  >,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const session = await activeSession();
  if (!session || sender.tab?.id !== session.targetTabId) {
    return;
  }
  if (message.type === "content:microphone") {
    await sendOffscreen(
      extensionMessage({
        enabled: message.enabled,
        recipient: "offscreen",
        sessionId: session.sessionId,
        type: "worker:microphone",
      }),
    );
    return;
  }
  await sendOffscreen(
    extensionMessage({
      action: message.action,
      recipient: "offscreen",
      sessionId: session.sessionId,
      type: "worker:command",
    }),
  );
  if (message.action === "cancel") {
    await sendToTarget(
      session.targetTabId,
      extensionMessage({
        recipient: "content",
        sessionId: session.sessionId,
        type: "worker:cleanup",
      }),
    );
    await clearActiveSession();
  }
}

async function restoreTarget(
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const session = await activeSession();
  if (!session || sender.tab?.id !== session.targetTabId) {
    return;
  }
  await sendToTarget(
    session.targetTabId,
    extensionMessage({
      recipient: "content",
      sessionId: session.sessionId,
      state: session.state,
      type: "worker:prepare",
    }),
  );
}

async function updateTargetState(
  message: Extract<WorkerMessage, { readonly type: "offscreen:state" }>,
): Promise<void> {
  const session = await activeSession();
  if (!session || session.sessionId !== message.sessionId) {
    return;
  }
  const updated = { ...session, state: message.state };
  await saveActiveSession(updated);
  await sendToTarget(
    session.targetTabId,
    extensionMessage({
      recipient: "content",
      sessionId: session.sessionId,
      state: message.state,
      type: "worker:state",
    }),
  );
}

async function completeRecording(
  message: Extract<WorkerMessage, { readonly type: "offscreen:completed" }>,
): Promise<void> {
  const session = await activeSession();
  if (!session || session.sessionId !== message.sessionId) {
    return;
  }
  await sendToTarget(
    session.targetTabId,
    extensionMessage({
      recipient: "content",
      sessionId: session.sessionId,
      type: "worker:cleanup",
    }),
  );
  await clearActiveSession();
  const url = new URL(session.appOrigin);
  url.searchParams.set(OKOU_RECORDER_SESSION_QUERY, message.sessionId);
  await chrome.tabs.create({ active: true, url: url.href });
}

async function handleOffscreenError(
  message: Extract<WorkerMessage, { readonly type: "offscreen:error" }>,
): Promise<void> {
  const session = await activeSession();
  if (!session || session.sessionId !== message.sessionId) {
    return;
  }
  await sendToTarget(
    session.targetTabId,
    extensionMessage({
      code: message.code,
      recipient: "content",
      sessionId: session.sessionId,
      type: "worker:error",
    }),
  );
  if (message.code !== "microphone-permission") {
    await sendToTarget(
      session.targetTabId,
      extensionMessage({
        recipient: "content",
        sessionId: session.sessionId,
        type: "worker:cleanup",
      }),
    );
    await clearActiveSession();
  }
}

async function handleWorkerMessage(
  message: WorkerMessage,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  switch (message.type) {
    case "content:command":
    case "content:microphone": {
      await handleContentMessage(message, sender);
      break;
    }
    case "content:mounted": {
      await restoreTarget(sender);
      break;
    }
    case "offscreen:state": {
      await updateTargetState(message);
      break;
    }
    case "offscreen:completed": {
      await completeRecording(message);
      break;
    }
    case "offscreen:error": {
      await handleOffscreenError(message);
      break;
    }
    case "handoff:consumed": {
      if (!(await activeSession())) {
        await chrome.offscreen.closeDocument();
      }
      break;
    }
  }
}

chrome.action.onClicked.addListener(() => {
  void beginCapture();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const session = await activeSession();
    if (session?.targetTabId === tabId) {
      await cancelSession(session);
    }
  })();
});

chrome.runtime.onMessage.addListener((value, sender, sendResponse) => {
  if (!isRuntimeMessage(value) || value.recipient !== "worker") {
    return false;
  }
  void handleWorkerMessage(value, sender).then(() => {
    sendResponse({ ok: true });
  });
  return true;
});
