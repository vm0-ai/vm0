import { fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@okouai/ui/components/ui/sonner";
import { command } from "ccstate";

import type { TestContext } from "../signals/__tests__/test-helpers";
import {
  clearMockedAuthOnAbort,
  type MockedClientSession,
  type MockedInvitation,
  type MockedMembership,
  mockOrganization,
  mockUser,
} from "./mock-auth";
import { bootstrap$ } from "../signals/bootstrap";
import { setupRouter } from "../views/main";
import {
  mockPushState,
  mockReplaceState,
  pushState,
  setPathname,
  setSearch,
} from "../signals/location";
import { vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { setMockFeatureSwitches } from "../mocks/handlers/api-feature-switches.helpers";
import { FEATURE_SWITCH_CACHE_KEY } from "../signals/external/feature-switch-state";
import { localStorageSignals } from "../signals/external/local-storage";
import { setDebugLoggerLocalStorage$ } from "../signals/bootstrap/loggers";
import { detach, Reason } from "../signals/utils";
import { SharedWorkerTestBootstrap } from "../shared-database/test-bridge.ts";

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

export interface SetupBootstrapOptions {
  context: TestContext;
  path: string;
  beforeBootstrap?: (signal: AbortSignal) => void;
  user?: {
    id: string;
    fullName: string;
    email?: string;
    firstName?: string;
    imageUrl?: string;
    createdAt?: Date;
    createOrganizationEnabled?: boolean;
    createOrganizationsLimit?: number | null;
    clientSessions?: MockedClientSession[];
  } | null;
  session?: { token: string } | null;
  org?: {
    activeOrg?: {
      id: string;
      name: string;
      slug?: string;
      imageUrl?: string;
      hasImage?: boolean;
    } | null;
    memberships?: MockedMembership[];
    pendingInvitations?: MockedInvitation[];
  };
  debugLoggers?: string[];
  cachedFeatureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
  featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
  afterSharedDatabaseWorkerHeartbeat?: () => Promise<void>;
}

export interface SetupPageOptions extends SetupBootstrapOptions {
  withoutRender?: boolean;
}

/**
 * Run the production bootstrap lifecycle. Signal tests omit `render`; page
 * tests provide the Router setup through `setupPage` below.
 */
export async function setupBootstrap(
  options: SetupBootstrapOptions,
  render: () => void = () => {},
): Promise<void> {
  ensureTestLocalStorage();
  // setupPage exercises the shared MSW fixture data even when a test does not
  // customize a handler. Start the lazy mock lifecycle so abort resets any
  // fixture mutations made by the application during this test.
  void options.context.mocks;
  options.beforeBootstrap?.(options.context.signal);
  createPushStateMock(options.context.signal);
  pushState({}, "", options.path);

  if (options.debugLoggers) {
    options.context.store.set(
      setDebugLoggerLocalStorage$,
      JSON.stringify(options.debugLoggers ?? []),
    );
  }

  // Simulate browser state before app startup: clear any prior cache, then
  // optionally seed it as if the user is returning with a populated cache.
  // Reading featureSwitch$ is synchronous, so the cache must be in place
  // before bootstrap runs (especially for `detachedSetupPage`, which does
  // not await the bootstrap-driven SWR refresh).
  const defaultOrgId = "org_default";
  const activeOrgId = options.org ? options.org.activeOrg?.id : defaultOrgId;
  options.context.store.set(clearFeatureSwitchCacheForTest$);
  const featureSwitchOverrides = { ...options.featureSwitches };
  if (options.featureSwitches) {
    setMockFeatureSwitches(featureSwitchOverrides);
  }
  const cachedFeatureSwitchOverrides = {
    ...(options.cachedFeatureSwitches ?? featureSwitchOverrides),
  };
  const cachedFeatureSwitches = getAllFeatureStates({
    orgId: activeOrgId,
    overrides: cachedFeatureSwitchOverrides,
  });
  options.context.store.set(
    setFeatureSwitchCacheForTest$,
    cachedFeatureSwitches,
  );
  new SharedWorkerTestBootstrap(
    options.context.store,
    options.context.workerStore,
    options.context.signal,
    options.afterSharedDatabaseWorkerHeartbeat,
  );

  mockUser(
    options.user !== undefined
      ? options.user
      : {
          id: "test-user-123",
          fullName: "Test User",
        },
    options.session ?? {
      token: "test-token",
    },
  );

  // Default active org so needsOrgSelection$ doesn't redirect to choose-organization.
  // Tests that explicitly configure org state before calling setupPage can pass
  // `org` to override this default (or call mockOrganization() before setupPage).
  if (options.org) {
    mockOrganization(options.org);
  } else {
    mockOrganization({
      activeOrg: { id: defaultOrgId, name: "Default Org" },
      memberships: [{ id: defaultOrgId }],
    });
  }
  clearMockedAuthOnAbort(options.context.signal);
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
  await options.context.store.set(bootstrap$, render, options.context.signal);
}

export async function setupPage(options: SetupPageOptions): Promise<void> {
  await setupBootstrap(options, () => {
    setupRouter(options.context.store, (element) => {
      if (options.withoutRender) {
        return;
      }
      const { unmount } = render(element);
      options.context.signal.addEventListener("abort", () => {
        unmount();
      });
    });
  });
}

/**
 * Fire-and-forget variant of `setupPage` for tests where the page setup
 * initiates a long-running polling loop that never resolves on its own
 * (e.g. an active run that stays in "pending" state during the test).
 *
 * Tests should use `detachedSetupPage` and pair it with `await waitFor(...)`
 * to assert the desired rendered state rather than awaiting setup completion.
 *
 * Note: because setup runs concurrently with the test body, teardown (signal
 * abort) may race with in-flight async operations. Ensure test assertions do
 * not depend on the setup promise having fully settled.
 */
export function detachedSetupPage(options: Parameters<typeof setupPage>[0]) {
  detach(setupPage(options), Reason.Entrance, "test");
}

// Helper to create a browser history mock that updates mockLocation.
function createPushStateMock(signal: AbortSignal) {
  interface HistoryEntry {
    readonly data: unknown;
    readonly url: URL;
  }

  const entries: HistoryEntry[] = [];
  let currentEntryIndex = -1;

  const resolveUrl = (url?: string | URL | null) => {
    return new URL(url?.toString() ?? "/", "http://localhost");
  };

  const updateLocation = (entry: HistoryEntry) => {
    setPathname(entry.url.pathname, signal);
    setSearch(entry.url.search, signal);
  };

  const fn = vi.fn<typeof window.history.pushState>(
    (data: unknown, _unused: string, url?: string | URL | null) => {
      const entry = { data, url: resolveUrl(url) };
      entries.splice(currentEntryIndex + 1);
      entries.push(entry);
      currentEntryIndex = entries.length - 1;
      updateLocation(entry);
    },
  );
  mockPushState(fn, signal);

  const replaceFn = vi.fn<typeof window.history.replaceState>(
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
  return fn;
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
  await fastUser.paste(value);
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
  | "link"
  | "menuitem"
  | "menuitemcheckbox"
  | "menuitemradio"
  | "radio"
  | "tab"
  | "cell"
  | "columnheader"
  | "rowheader"
  | "gridcell";

const ROLE_SELECTORS: Record<TextContentRole, string> = {
  button: 'button, [role="button"]',
  link: 'a[href], [role="link"]',
  menuitem: '[role="menuitem"]',
  menuitemcheckbox: '[role="menuitemcheckbox"]',
  menuitemradio: '[role="menuitemradio"]',
  // Base UI's Radio puts the role on the visible element and renders a
  // separate 1x1 input for form submission, so the role selector alone is
  // the visible control.
  radio: '[role="radio"]',
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
