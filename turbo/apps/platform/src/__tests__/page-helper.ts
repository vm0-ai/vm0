import { fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@okouai/ui/components/ui/sonner";
import { command } from "ccstate";

import type { TestContext } from "../signals/__tests__/test-helpers";
import type { mockOrganization, mockUser } from "./mock-auth";
import { bootstrap$ } from "../signals/bootstrap";
import { setupRouter } from "../views/main";
import {
  mockPushState,
  mockReplaceState,
  setHash,
  setPathname,
  setSearch,
} from "../signals/location";
import { vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { setMockFeatureSwitches } from "../mocks/handlers/api-feature-switches.helpers";
import { FEATURE_SWITCH_CACHE_KEY } from "../signals/external/feature-switch-state";
import { localStorageSignals } from "../signals/external/local-storage";
import { setDebugLoggerLocalStorage$ } from "../signals/bootstrap/loggers";
import { detach, Reason } from "../signals/utils";
import {
  setupSharedWorkerTestBootstrap$,
  type SharedWorkerTestTransport,
} from "../shared-database/test-bridge.ts";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "../i18n/resources.ts";
import { initializeI18n } from "../i18n/index.ts";

export const TEST_APP_VERSION = "0.540.0";

const {
  set$: setFeatureSwitchCacheLocalStorage$,
  clear$: clearFeatureSwitchCacheLocalStorage$,
} = localStorageSignals(FEATURE_SWITCH_CACHE_KEY);

const setFeatureSwitchCacheForTest$ = command(
  ({ set }, switches: Record<FeatureSwitchKey, boolean>) => {
    set(setFeatureSwitchCacheLocalStorage$, JSON.stringify(switches));
  },
);

const clearFeatureSwitchCacheForTest$ = command(({ set }) => {
  set(clearFeatureSwitchCacheLocalStorage$);
});

function ensureTestLocalStorage(): void {
  const currentLocalStorage = globalThis.localStorage;
  if (
    typeof currentLocalStorage !== "undefined" &&
    typeof currentLocalStorage.getItem === "function" &&
    typeof currentLocalStorage.setItem === "function"
  ) {
    return;
  }
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear: () => {
        values.clear();
      },
      getItem: (key: string) => {
        return values.get(key) ?? null;
      },
      key: (index: number) => {
        return Array.from(values.keys())[index] ?? null;
      },
      get length() {
        return values.size;
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    } satisfies Storage,
  });
}

type MockedUser = Exclude<Parameters<typeof mockUser>[0], null>;
type MockedSession = Exclude<Parameters<typeof mockUser>[1], null>;
type MockedOrganization = Parameters<typeof mockOrganization>[0];

export type SetupPageAuth = null | {
  readonly user: MockedUser;
  readonly organization?: MockedOrganization;
  readonly session?: MockedSession | null;
};

export interface SetupPageOptions {
  readonly appVersion?: string;
  readonly context: TestContext;
  readonly path: string;
  readonly host?: string;
  readonly locale?: SupportedLocale;
  readonly auth?: SetupPageAuth;
  readonly debugLoggers?: string[];
  readonly cachedFeatureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
  readonly featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
  readonly afterSharedDatabaseWorkerHeartbeat?: () => Promise<void>;
  readonly sharedWorkerAppVersion?: string;
  readonly sharedWorkerTestTransport?: SharedWorkerTestTransport;
}

const DEFAULT_USER: MockedUser = {
  id: "test-user-123",
  fullName: "Test User",
};

const DEFAULT_SESSION: MockedSession = { token: "test-token" };

const DEFAULT_ORGANIZATION: MockedOrganization = {
  activeOrg: { id: "org_default", name: "Default Org" },
  memberships: [{ id: "org_default" }],
};

function initialPageUrl(path: string, host: string): URL {
  const protocol = host === "localhost" ? "http" : "https";
  return new URL(path, `${protocol}://${host}`);
}

function resolveAuth(options: SetupPageOptions): {
  readonly organization: MockedOrganization;
  readonly session: MockedSession | null;
  readonly signedOut: boolean;
  readonly user: MockedUser | null;
} {
  if (options.auth === null) {
    return {
      organization: { activeOrg: null, memberships: [] },
      session: null,
      signedOut: true,
      user: null,
    };
  }

  return {
    organization: options.auth?.organization ?? DEFAULT_ORGANIZATION,
    session:
      options.auth?.session === undefined
        ? DEFAULT_SESSION
        : options.auth.session,
    signedOut: false,
    user: options.auth?.user ?? DEFAULT_USER,
  };
}

async function setupPageAsync(
  options: SetupPageOptions,
  pageRendered: () => void,
): Promise<void> {
  ensureTestLocalStorage();
  await initializeI18n(options.locale ?? DEFAULT_LOCALE);
  // setupPage exercises the shared MSW fixture data even when a test does not
  // customize a handler. Start the lazy mock lifecycle so abort resets any
  // fixture mutations made by the application during this test.
  void options.context.mocks;
  if (options.locale) {
    options.context.mocks.data.userPreferences({
      locale: options.locale,
      supportedLocales: [...SUPPORTED_LOCALES],
    });
  }
  const initialUrl = initialPageUrl(options.path, options.host ?? "localhost");
  options.context.mocks.browser.url(initialUrl.toString());
  createPushStateMock(options.context.signal, initialUrl);

  if (options.debugLoggers) {
    options.context.store.set(
      setDebugLoggerLocalStorage$,
      JSON.stringify(options.debugLoggers ?? []),
    );
  }

  // Simulate browser state before app startup: clear any prior cache, then
  // optionally seed it as if the user is returning with a populated cache.
  // Reading featureSwitch$ is synchronous, so the cache must be in place
  // before bootstrap starts its SWR refresh.
  const auth = resolveAuth(options);
  const clerk = options.context.mocks.clerk();
  const activeOrgId = auth.organization.activeOrg?.id ?? null;
  options.context.store.set(clearFeatureSwitchCacheForTest$);
  const featureSwitchOverrides = { ...options.featureSwitches };
  if (options.featureSwitches) {
    setMockFeatureSwitches(featureSwitchOverrides);
  }
  const cachedFeatureSwitchOverrides = {
    ...(options.cachedFeatureSwitches ?? featureSwitchOverrides),
  };
  const cachedFeatureSwitches = getAllFeatureStates({
    orgId: activeOrgId ?? undefined,
    overrides: cachedFeatureSwitchOverrides,
  });
  options.context.store.set(
    setFeatureSwitchCacheForTest$,
    cachedFeatureSwitches,
  );
  clerk.sessionSignedOut(auth.signedOut);
  clerk.user(auth.user, auth.session);
  clerk.organization(auth.organization);
  const user = auth.user;
  if (user) {
    options.context.mocks.api(authContract.me, ({ respond }) => {
      return respond(200, {
        userId: user.id,
        email: user.email ?? "test@example.com",
        orgId: activeOrgId ?? null,
      });
    });
  }
  options.context.store.set(
    setupSharedWorkerTestBootstrap$,
    {
      appVersion: options.sharedWorkerAppVersion ?? TEST_APP_VERSION,
      workerStore: options.context.workerStore,
      identity:
        auth.user && activeOrgId
          ? { userId: auth.user.id, orgId: activeOrgId }
          : null,
      transport: options.sharedWorkerTestTransport ?? "direct",
      ...(options.afterSharedDatabaseWorkerHeartbeat
        ? { afterHeartbeat: options.afterSharedDatabaseWorkerHeartbeat }
        : {}),
    },
    options.context.signal,
  );
  options.context.signal.addEventListener(
    "abort",
    () => {
      toast.dismiss();
    },
    { once: true },
  );

  // Not wrapped in act() — background polling loops would cause act() to
  // hang indefinitely waiting for them to settle. React "not wrapped in
  // act" warnings are suppressed in setup.ts.
  const runtime = options.context.store.set(
    bootstrap$,
    options.appVersion ?? TEST_APP_VERSION,
    () => {
      setupRouter(options.context.store, (element) => {
        const { unmount } = render(element);
        pageRendered();
        options.context.signal.addEventListener("abort", unmount, {
          once: true,
        });
      });
    },
    options.context.signal,
  );
  detach(
    runtime.sharedDatabaseDaemon,
    Reason.Daemon,
    "test shared database daemon",
  );
  detach(
    runtime.authenticatedRealtimeDaemon,
    Reason.Daemon,
    "test authenticated realtime daemon",
  );
  detach(runtime.ready, Reason.Entrance, "test page readiness");
}

function waitForFirstPageContent(signal: AbortSignal): {
  readonly pageRendered: () => void;
  readonly ready: Promise<void>;
} {
  let pageHasRendered = false;
  let skeletonHasMounted = false;
  let settled = false;
  let resolveReady = (): void => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const observer = new MutationObserver(checkPageContent);

  function settle(): void {
    if (settled) {
      return;
    }
    settled = true;
    observer.disconnect();
    signal.removeEventListener("abort", settle);
    resolveReady();
  }

  function checkPageContent(): void {
    const skeleton = document.querySelector('[data-testid="app-skeleton"]');
    skeletonHasMounted ||= skeleton !== null;
    if (
      pageHasRendered &&
      (!skeletonHasMounted ||
        skeleton === null ||
        skeleton.getAttribute("aria-hidden") === "true")
    ) {
      settle();
    }
  }

  observer.observe(document.body, {
    attributeFilter: ["aria-hidden"],
    attributes: true,
    childList: true,
    subtree: true,
  });
  signal.addEventListener("abort", settle, { once: true });
  checkPageContent();

  return {
    pageRendered: () => {
      pageHasRendered = true;
      checkPageContent();
    },
    ready,
  };
}

export interface StartedPage {
  readonly ready: Promise<void>;
}

export async function startPage(
  options: SetupPageOptions,
): Promise<StartedPage> {
  const content = waitForFirstPageContent(options.context.signal);
  await setupPageAsync(options, content.pageRendered);
  return { ready: content.ready };
}

export async function setupPage(options: SetupPageOptions): Promise<void> {
  const page = await startPage(options);
  await page.ready;
}

// Helper to create a browser history mock that updates mockLocation.
function createPushStateMock(signal: AbortSignal, initialUrl: URL): void {
  interface HistoryEntry {
    readonly data: unknown;
    readonly url: URL;
  }

  const entries: HistoryEntry[] = [{ data: null, url: initialUrl }];
  let currentEntryIndex = 0;
  let currentUrl = initialUrl;
  const replaceBrowserUrl = window.history.replaceState.bind(window.history);

  const resolveUrl = (url?: string | URL | null) => {
    return url === undefined || url === null
      ? currentUrl
      : new URL(url.toString(), currentUrl);
  };

  const updateLocation = (entry: HistoryEntry) => {
    currentUrl = entry.url;
    if (entry.url.origin === window.location.origin) {
      replaceBrowserUrl(entry.data, "", entry.url);
    } else {
      window.location.href = entry.url.toString();
    }
    setPathname(entry.url.pathname, signal);
    setSearch(entry.url.search, signal);
    setHash(entry.url.hash, signal);
  };

  updateLocation(entries[0]);

  const fn = vi
    .spyOn(window.history, "pushState")
    .mockImplementation(
      (data: unknown, _unused: string, url?: string | URL | null) => {
        const entry = { data, url: resolveUrl(url) };
        entries.splice(currentEntryIndex + 1);
        entries.push(entry);
        currentEntryIndex = entries.length - 1;
        updateLocation(entry);
      },
    );
  mockPushState(fn, signal);

  const replaceFn = vi
    .spyOn(window.history, "replaceState")
    .mockImplementation(
      (data: unknown, _unused: string, url?: string | URL | null) => {
        const entry = { data, url: resolveUrl(url) };
        if (currentEntryIndex === -1) {
          entries.push(entry);
          currentEntryIndex = 0;
        } else {
          entries[currentEntryIndex] = entry;
        }
        updateLocation(entry);
      },
    );
  mockReplaceState(replaceFn, signal);

  vi.spyOn(window.history, "back").mockImplementation(() => {
    if (currentEntryIndex <= 0) {
      return;
    }
    currentEntryIndex -= 1;
    const entry = entries[currentEntryIndex];
    if (!entry) {
      return;
    }
    updateLocation(entry);
    window.dispatchEvent(new PopStateEvent("popstate", { state: entry.data }));
  });
}

/**
 * Fast input helper: selects all existing content then types the new value.
 * Uses `delay: null` to skip per-keystroke timeouts — same events, zero delay.
 * Use this instead of `user.clear() + user.type()`.
 */
export async function fill(element: Element, value: string): Promise<void> {
  const fastUser = userEvent.setup({ delay: null });
  const editableElement =
    element.getAttribute("contenteditable") === "true"
      ? element
      : (element.querySelector('[contenteditable="true"]') ?? element);
  await fastUser.click(editableElement);
  await fastUser.keyboard("{Control>}a{/Control}");
  if (value) {
    await fastUser.paste(value);
  } else {
    await fastUser.keyboard("{Backspace}");
  }
}

/**
 * Fire a click on `element` that works for both regular buttons and headless UI
 * triggers (Dropdown/Select/Popover open on `pointerdown`, not `click`).
 *
 * Roughly 3x faster than `userEvent.click(el)` in happy-dom because it skips
 * the full pointer-event simulation (pointermove, hover, focus tracking)
 * that userEvent runs. Dispatches `pointerdown` + `click` only.
 */
export function click(element: Element): void {
  fireEvent.pointerDown(element, { button: 0 });
  fireEvent.click(element);
}

/**
 * Keep a rendered element's CSS animation pending until the returned callback
 * runs. happy-dom does not implement Web Animations, so Base UI otherwise
 * completes exit transitions immediately instead of retaining visible content.
 */
export function holdElementAnimations(element: Element): () => void {
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  Object.defineProperty(element, "getAnimations", {
    configurable: true,
    value: () => {
      return [{ finished }];
    },
  });
  return finish;
}

/**
 * Text-content ARIA roles — roles whose accessible name is derived from a
 * subtree text walk, so `*ByRole(role)` from @testing-library pays for an
 * O(documentSize) ARIA tree traversal even without `{ name }`. Profiling
 * showed `screen.getAllByRole("button")` taking ~360ms on the /connectors
 * page with only 5 buttons rendered.
 */
type TextContentRole =
  | "button"
  | "combobox"
  | "link"
  | "menuitem"
  | "menuitemcheckbox"
  | "menuitemradio"
  | "radio"
  | "option"
  | "tab"
  | "cell"
  | "columnheader"
  | "rowheader"
  | "gridcell";

const ROLE_SELECTORS: Record<TextContentRole, string> = {
  button: 'button, [role="button"]',
  combobox: 'select, [role="combobox"]',
  link: 'a[href], [role="link"]',
  menuitem: '[role="menuitem"]',
  menuitemcheckbox: '[role="menuitemcheckbox"]',
  menuitemradio: '[role="menuitemradio"]',
  // Base UI's Radio puts the role on the visible element and renders a
  // separate 1x1 input for form submission, so the role selector alone is
  // the visible control.
  radio: '[role="radio"]',
  option: 'option, [role="option"]',
  tab: '[role="tab"]',
  cell: 'td, [role="cell"]',
  // Plain <th> inside <thead> has implicit role="columnheader"; a <th
  // scope="row"> is a rowheader, so exclude it here to match
  // @testing-library/dom's role disambiguation.
  columnheader: 'th:not([scope="row"]), [role="columnheader"]',
  rowheader: 'th[scope="row"], [role="rowheader"]',
  gridcell: '[role="gridcell"]',
};

/**
 * Element is hidden from the accessibility tree — used to match the default
 * `getAllByRole(role, { hidden: false })` behaviour from
 * `@testing-library/dom`, which excludes ancestors flagged with
 * `aria-hidden="true"`, the `hidden` attribute, or `inert`. Modal overlays
 * commonly leave background portals mounted with `aria-hidden`; matching
 * those would inflate counts vs. the original role queries.
 */
function isAccessibilityHidden(element: Element): boolean {
  return element.closest('[aria-hidden="true"], [hidden], [inert]') !== null;
}

/**
 * Fast role lookup that returns the same elements as
 * `getAllByRole(role)` for text-content roles, without the ARIA tree walk
 * `@testing-library/dom` performs. Use this anywhere you'd otherwise call
 * `screen.getAllByRole("button").find(el => /label/.test(el.textContent))`
 * or `within(container).getAllByRole("link")`.
 *
 * The native tag is the primary lookup; the `[role="…"]` fallback covers
 * elements that override their role explicitly. Elements inside an
 * `aria-hidden`, `hidden`, or `inert` subtree are filtered out to match the
 * default `getAllByRole` visibility semantics.
 */
export function queryAllByRoleFast(
  role: TextContentRole,
  container: ParentNode = document.body,
): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(ROLE_SELECTORS[role]),
  ).filter((el) => {
    return !isAccessibilityHidden(el);
  });
}
