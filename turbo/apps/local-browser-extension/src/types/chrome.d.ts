interface ChromeRuntimeManifest {
  readonly version: string;
}

interface ChromeRuntimeMessageSender {
  readonly tab?: ChromeTab;
  readonly url?: string;
}

type ChromeMessageResponse = (response?: unknown) => void;

interface ChromeRuntime {
  readonly id: string;
  readonly lastError?: { readonly message?: string };
  getManifest(): ChromeRuntimeManifest;
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  onMessage: {
    addListener(
      callback: (
        message: unknown,
        sender: ChromeRuntimeMessageSender,
        sendResponse: ChromeMessageResponse,
      ) => boolean | void,
    ): void;
  };
  onInstalled: {
    addListener(callback: () => void): void;
  };
  onStartup: {
    addListener(callback: () => void): void;
  };
}

interface ChromeStorageArea {
  get(
    keys?: string | string[] | Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface ChromeStorage {
  readonly local: ChromeStorageArea;
}

interface ChromeTab {
  readonly id?: number;
  readonly windowId?: number;
  readonly title?: string;
  readonly url?: string;
  readonly favIconUrl?: string;
  readonly active?: boolean;
}

interface ChromeTabs {
  query(queryInfo: {
    readonly active?: boolean;
    readonly currentWindow?: boolean;
    readonly lastFocusedWindow?: boolean;
  }): Promise<ChromeTab[]>;
  get(tabId: number): Promise<ChromeTab>;
  create(createProperties: { readonly url: string }): Promise<ChromeTab>;
  update(
    tabId: number,
    updateProperties: {
      readonly active?: boolean;
      readonly url?: string;
    },
  ): Promise<ChromeTab>;
  remove(tabId: number | number[]): Promise<void>;
  captureVisibleTab(
    windowId?: number,
    options?: {
      readonly format?: "jpeg" | "png";
      readonly quality?: number;
    },
  ): Promise<string>;
}

interface ChromeWindows {
  update(
    windowId: number,
    updateInfo: {
      readonly focused?: boolean;
    },
  ): Promise<void>;
}

interface ChromeScriptingInjectionResult<T = unknown> {
  readonly frameId: number;
  readonly result?: T;
}

interface ChromeScripting {
  executeScript<TArgs extends unknown[], TResult>(details: {
    readonly target: { readonly tabId: number };
    readonly func: (...args: TArgs) => TResult;
    readonly args?: TArgs;
  }): Promise<ChromeScriptingInjectionResult<Awaited<TResult>>[]>;
}

interface ChromeAlarm {
  readonly name: string;
}

interface ChromeAlarms {
  create(
    name: string,
    alarmInfo: {
      readonly delayInMinutes?: number;
      readonly periodInMinutes?: number;
    },
  ): Promise<void>;
  clear(name: string): Promise<boolean>;
  onAlarm: {
    addListener(callback: (alarm: ChromeAlarm) => void): void;
  };
}

interface ChromeAction {
  setBadgeText(details: { readonly text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { readonly color: string }): Promise<void>;
  setTitle(details: { readonly title: string }): Promise<void>;
}

interface ChromeApi {
  readonly action?: ChromeAction;
  readonly alarms: ChromeAlarms;
  readonly runtime: ChromeRuntime;
  readonly scripting: ChromeScripting;
  readonly storage: ChromeStorage;
  readonly tabs: ChromeTabs;
  readonly windows: ChromeWindows;
}

declare const chrome: ChromeApi;
declare const __EXTENSION_VERSION__: string;
