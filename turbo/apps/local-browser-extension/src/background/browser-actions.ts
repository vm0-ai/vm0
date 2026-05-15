import type {
  LocalBrowserCommandError,
  LocalBrowserCommandErrorCode,
  LocalBrowserCommandResult,
  LocalBrowserReadCommandKind,
  LocalBrowserTab,
} from "@vm0/api-contracts/contracts/zero-local-browser";
import type { LocalBrowserHostCommand } from "../shared/protocol";

const MAX_SNAPSHOT_CHARS = 480_000;
const MAX_SELECTION_CHARS = 64_000;
const MAX_IMAGE_BASE64_CHARS = 1_900_000;

export class LocalBrowserCommandFailure extends Error {
  constructor(
    readonly code: LocalBrowserCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LocalBrowserCommandFailure";
  }
}

function fail(
  code: LocalBrowserCommandErrorCode,
  message: string,
): LocalBrowserCommandFailure {
  return new LocalBrowserCommandFailure(code, message);
}

function chromeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Chrome extension API failed";
}

export function commandErrorFromUnknown(
  error: unknown,
): LocalBrowserCommandError {
  if (error instanceof LocalBrowserCommandFailure) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  const message = chromeErrorMessage(error);
  if (
    message.includes("Cannot access") ||
    message.includes("permission") ||
    message.includes("Permission")
  ) {
    return { code: "permission_denied", message };
  }
  if (
    message.includes("No tab") ||
    message.includes("Cannot find a tab") ||
    message.includes("Invalid tab")
  ) {
    return { code: "no_active_tab", message };
  }
  return { code: "unsupported_page", message };
}

function tabIdNumber(tabId: string | undefined): number | null {
  if (!tabId) {
    return null;
  }
  const parsed = Number.parseInt(tabId, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function tabToResult(tab: ChromeTab): LocalBrowserTab {
  return {
    id: String(tab.id ?? ""),
    active: tab.active,
    faviconUrl: tab.favIconUrl,
    title: tab.title,
    url: tab.url,
  };
}

function isHttpUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function assertHttpUrl(value: string | undefined, message: string): string {
  if (!isHttpUrl(value)) {
    throw fail("unsupported_page", message);
  }
  return value as string;
}

async function getActiveTab(): Promise<ChromeTab> {
  const currentWindowTabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (currentWindowTabs[0]?.id) {
    return currentWindowTabs[0];
  }

  const focusedTabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (focusedTabs[0]?.id) {
    return focusedTabs[0];
  }

  throw fail("no_active_tab", "No active Chrome tab is available");
}

async function getTargetTab(tabId: string | undefined): Promise<ChromeTab> {
  const parsed = tabIdNumber(tabId);
  if (parsed) {
    return await chrome.tabs.get(parsed);
  }
  return await getActiveTab();
}

async function getInjectableTargetTab(
  tabId: string | undefined,
): Promise<ChromeTab> {
  const tab = await getTargetTab(tabId);
  if (!tab.id) {
    throw fail("no_active_tab", "Target tab does not have an id");
  }
  assertHttpUrl(tab.url, "Local browser commands only support http(s) pages");
  return tab;
}

async function runScript<TArgs extends unknown[], TResult>(
  tabId: number,
  func: (...args: TArgs) => TResult,
  ...args: TArgs
): Promise<Awaited<TResult>> {
  const [result] = await chrome.scripting.executeScript({
    args,
    func,
    target: { tabId },
  });
  if (!result) {
    throw fail("unsupported_page", "No script result was returned");
  }
  return result.result as Awaited<TResult>;
}

function getPageSnapshot(maxChars: number) {
  const parts = [
    `Title: ${document.title}`,
    `URL: ${location.href}`,
    document.body?.innerText ?? "",
  ];
  const text = parts
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    contentType: "text/plain",
    snapshot: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}

function getPageSelection(maxChars: number) {
  const text = window.getSelection()?.toString() ?? "";
  return {
    text: text.slice(0, maxChars),
  };
}

function clickPageTarget(params: {
  readonly selector?: string;
  readonly x?: number;
  readonly y?: number;
}) {
  let element: Element | null = null;

  if (params.selector) {
    element = document.querySelector(params.selector);
    if (!element) {
      return {
        ok: false,
        message: `No element matched selector: ${params.selector}`,
      };
    }
    element.scrollIntoView({ block: "center", inline: "center" });
  } else if (params.x !== undefined && params.y !== undefined) {
    element = document.elementFromPoint(params.x, params.y);
    if (!element) {
      return {
        ok: false,
        message: `No element found at (${params.x}, ${params.y})`,
      };
    }
  }

  if (!(element instanceof HTMLElement)) {
    return { ok: false, message: "Target is not a clickable HTML element" };
  }

  element.focus();
  element.click();
  return { ok: true, details: "Clicked target" };
}

function typeIntoPageTarget(params: {
  readonly selector: string;
  readonly text: string;
}) {
  const element = document.querySelector(params.selector);
  if (!(element instanceof HTMLElement)) {
    return {
      ok: false,
      message: `No editable element matched selector: ${params.selector}`,
    };
  }

  element.focus();
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    element.value =
      element.value.slice(0, start) + params.text + element.value.slice(end);
    const nextPosition = start + params.text.length;
    element.setSelectionRange(nextPosition, nextPosition);
    element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, details: "Typed text" };
  }

  if (element.isContentEditable) {
    document.execCommand("insertText", false, params.text);
    element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return { ok: true, details: "Typed text" };
  }

  return { ok: false, message: "Target element is not editable" };
}

function scrollPage(params: {
  readonly direction: "up" | "down";
  readonly amount: number;
}) {
  const top = params.direction === "up" ? -params.amount : params.amount;
  window.scrollBy({ behavior: "smooth", top });
  return { ok: true, details: `Scrolled ${params.direction}` };
}

function assertPageActionResult(result: {
  readonly ok: boolean;
  readonly message?: string;
  readonly details?: string;
}): LocalBrowserCommandResult {
  if (!result.ok) {
    throw fail("unsupported_page", result.message ?? "Page action failed");
  }
  return {
    ok: true,
    ...(result.details ? { details: result.details } : {}),
  };
}

async function captureActiveTabScreenshot(
  tab: ChromeTab,
): Promise<LocalBrowserCommandResult> {
  if (!tab.active) {
    throw fail(
      "unsupported_page",
      "Screenshot requires the target tab to be active and visible",
    );
  }

  const windowId = tab.windowId;
  let dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: "png",
  });
  if (dataUrl.length > MAX_IMAGE_BASE64_CHARS) {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 75,
    });
  }

  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/u.exec(dataUrl);
  if (!match) {
    throw fail("unsupported_page", "Chrome returned an unsupported screenshot");
  }

  const imageBase64 = match[2] ?? "";
  return {
    imageBase64: imageBase64.slice(0, MAX_IMAGE_BASE64_CHARS),
    mimeType: match[1] as "image/jpeg" | "image/png" | "image/webp",
    truncated: imageBase64.length > MAX_IMAGE_BASE64_CHARS,
  };
}

async function focusTab(tab: ChromeTab): Promise<void> {
  if (!tab.id) {
    throw fail("no_active_tab", "Target tab does not have an id");
  }
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

function isReadCommandKind(
  kind: LocalBrowserHostCommand["kind"],
): kind is LocalBrowserReadCommandKind {
  return (
    kind === "tabs.list" ||
    kind === "tabs.current" ||
    kind === "page.snapshot" ||
    kind === "page.screenshot" ||
    kind === "page.selection" ||
    kind === "page.metadata"
  );
}

async function executeReadCommand(
  command: LocalBrowserHostCommand,
): Promise<LocalBrowserCommandResult> {
  switch (command.kind) {
    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs
          .filter((tab) => {
            return tab.id !== undefined;
          })
          .map(tabToResult),
      };
    }
    case "tabs.current": {
      const tab = await getTargetTab(command.payload.tabId);
      return { tab: tabToResult(tab) };
    }
    case "page.metadata": {
      const tab = await getTargetTab(command.payload.tabId);
      return {
        faviconUrl: tab.favIconUrl,
        title: tab.title ?? "",
        url: tab.url ?? "",
      };
    }
    case "page.snapshot": {
      const tab = await getInjectableTargetTab(command.payload.tabId);
      return await runScript(tab.id ?? 0, getPageSnapshot, MAX_SNAPSHOT_CHARS);
    }
    case "page.selection": {
      const tab = await getInjectableTargetTab(command.payload.tabId);
      return await runScript(
        tab.id ?? 0,
        getPageSelection,
        MAX_SELECTION_CHARS,
      );
    }
    case "page.screenshot": {
      const tab = await getTargetTab(command.payload.tabId);
      assertHttpUrl(tab.url, "Screenshots only support http(s) pages");
      return await captureActiveTabScreenshot(tab);
    }
    default:
      throw fail("unsupported_command", `Unsupported command: ${command.kind}`);
  }
}

async function executeWriteCommand(
  command: LocalBrowserHostCommand,
): Promise<LocalBrowserCommandResult> {
  switch (command.kind) {
    case "tabs.activate": {
      const tab = await getTargetTab(command.payload.tabId);
      await focusTab(tab);
      return { ok: true, details: "Activated tab" };
    }
    case "tabs.open": {
      const url = assertHttpUrl(
        command.payload.url,
        "tabs.open requires an http(s) URL",
      );
      const tab = await chrome.tabs.create({ url });
      return { ok: true, details: `Opened tab ${tab.id ?? ""}`.trim() };
    }
    case "tabs.close": {
      const parsed = tabIdNumber(command.payload.tabId);
      if (!parsed) {
        throw fail("no_active_tab", "tabs.close requires a tabId");
      }
      await chrome.tabs.remove(parsed);
      return { ok: true, details: "Closed tab" };
    }
    case "page.navigate": {
      const tab = await getTargetTab(command.payload.tabId);
      if (!tab.id) {
        throw fail("no_active_tab", "Target tab does not have an id");
      }
      const url = assertHttpUrl(
        command.payload.url,
        "page.navigate requires an http(s) URL",
      );
      await chrome.tabs.update(tab.id, { url });
      return { ok: true, details: "Navigated tab" };
    }
    case "page.scroll": {
      const tab = await getInjectableTargetTab(command.payload.tabId);
      const direction = command.payload.direction;
      const amount = command.payload.amount;
      if (!direction || amount === undefined) {
        throw fail(
          "unsupported_command",
          "page.scroll requires direction and amount",
        );
      }
      const result = await runScript(tab.id ?? 0, scrollPage, {
        amount,
        direction,
      });
      return assertPageActionResult(result);
    }
    case "page.click": {
      const tab = await getInjectableTargetTab(command.payload.tabId);
      const result = await runScript(tab.id ?? 0, clickPageTarget, {
        selector: command.payload.selector,
        x: command.payload.x,
        y: command.payload.y,
      });
      return assertPageActionResult(result);
    }
    case "page.type": {
      const tab = await getInjectableTargetTab(command.payload.tabId);
      if (!command.payload.selector || command.payload.text === undefined) {
        throw fail(
          "unsupported_command",
          "page.type requires selector and text",
        );
      }
      const result = await runScript(tab.id ?? 0, typeIntoPageTarget, {
        selector: command.payload.selector,
        text: command.payload.text,
      });
      return assertPageActionResult(result);
    }
    default:
      throw fail("unsupported_command", `Unsupported command: ${command.kind}`);
  }
}

export async function executeLocalBrowserCommand(
  command: LocalBrowserHostCommand,
): Promise<LocalBrowserCommandResult> {
  if (isReadCommandKind(command.kind)) {
    return await executeReadCommand(command);
  }
  return await executeWriteCommand(command);
}
