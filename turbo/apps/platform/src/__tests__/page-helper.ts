import { fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { command } from "ccstate";

import type { TestContext } from "../signals/__tests__/test-helpers";
import {
  clearMockedAuth,
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
import { updateSearchParams$ } from "../signals/route";
import { vi } from "vitest";
import type { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { setMockFeatureSwitches } from "../mocks/handlers/api-feature-switches.helpers";
import { FEATURE_SWITCH_CACHE_KEY } from "../signals/external/feature-switch";
import { localStorageSignals } from "../signals/external/local-storage";
import { setDebugLoggerLocalStorage$ } from "../signals/bootstrap/loggers";
import { detach, Reason } from "../signals/utils";

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
  if (typeof localStorage !== "undefined") {
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

export async function setupPage(options: {
  context: TestContext;
  path: string;
  user?: {
    id: string;
    fullName: string;
    email?: string;
    firstName?: string;
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
  featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
  withoutRender?: boolean;
}) {
  ensureTestLocalStorage();
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
  if (options.featureSwitches) {
    setMockFeatureSwitches(options.featureSwitches);
    options.context.store.set(
      setFeatureSwitchCacheForTest$,
      getAllFeatureStates({
        orgId: activeOrgId,
        overrides: options.featureSwitches,
      }),
    );
  }

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
  options.context.signal.addEventListener("abort", () => {
    clearMockedAuth();
  });

  if (options.withoutRender) {
    await options.context.store.set(
      bootstrap$,
      () => {},
      options.context.signal,
    );
  } else {
    // Not wrapped in act() — background polling loops would cause act() to
    // hang indefinitely waiting for them to settle. React "not wrapped in
    // act" warnings are suppressed in setup.ts.
    await options.context.store.set(
      bootstrap$,
      () => {
        setupRouter(options.context.store, (element) => {
          const { unmount } = render(element);
          options.context.signal.addEventListener("abort", () => {
            unmount();
          });
        });
      },
      options.context.signal,
    );
  }
}

/**
 * Fire-and-forget variant of `setupPage` for tests where the page setup
 * initiates a long-running polling loop that never resolves on its own
 * (e.g. an active run that stays in "pending" state during the test).
 *
 * Use `await setupPage(...)` when the full initialization is expected to
 * complete within the test (e.g. static threads, finished runs). Use
 * `detachedSetupPage` only when the setup intentionally runs for the
 * duration of the test — in that case pair it with `await waitFor(...)` to
 * assert the desired rendered state rather than awaiting setup completion.
 *
 * Note: because setup runs concurrently with the test body, teardown (signal
 * abort) may race with in-flight async operations. Ensure test assertions do
 * not depend on the setup promise having fully settled.
 */
export function detachedSetupPage(options: Parameters<typeof setupPage>[0]) {
  detach(setupPage(options), Reason.Entrance, "test");
}

/**
 * Test helper: updates the pathname and triggers pathname$ recomputation
 * without re-running route setup. Use this in signal unit tests to simulate
 * a URL change that stays within the same route lifecycle.
 */
export const updateTestPathname$ = command(({ set }, newPathname: string) => {
  setPathname(newPathname);
  set(updateSearchParams$, new URLSearchParams());
});

// Helper to create a pushState mock that updates mockLocation
export function createPushStateMock(signal: AbortSignal) {
  const updateLocation = (url?: string | URL | null) => {
    if (typeof url === "string") {
      const urlObj = new URL(url, "http://localhost");
      setPathname(urlObj.pathname);
      setSearch(urlObj.search);
    }
  };

  const fn = vi.fn(
    (_data: unknown, _unused: string, url?: string | URL | null) => {
      updateLocation(url);
    },
  );
  mockPushState(fn as unknown as typeof window.history.pushState, signal);

  const replaceFn = vi.fn(
    (_data: unknown, _unused: string, url?: string | URL | null) => {
      updateLocation(url);
    },
  ) as unknown as typeof window.history.replaceState;
  mockReplaceState(replaceFn, signal);

  return fn;
}

/**
 * Fast input helper: selects all existing content then types the new value.
 * Uses `delay: null` to skip per-keystroke timeouts — same events, zero delay.
 * Use this instead of `user.clear() + user.type()`.
 */
export async function fill(element: Element, value: string): Promise<void> {
  const fastUser = userEvent.setup({ delay: null });
  await fastUser.click(element);
  await fastUser.keyboard("{Control>}a{/Control}");
  await fastUser.paste(value);
}

/**
 * Fire a click on `element` that works for both regular buttons and Radix
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
 * `aria-hidden="true"`, the `hidden` attribute, or `inert`. Radix overlays
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
