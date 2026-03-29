import { createElement, type ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { command, type Store } from "ccstate";
import { StoreProvider } from "ccstate-react";
import type { TestContext } from "../signals/__tests__/test-helpers";
import { clearMockedAuth, mockOrganization, mockUser } from "./mock-auth";
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
import type { FeatureSwitchKey } from "@vm0/core";
import { setFeatureSwitchLocalStorage$ } from "../signals/external/feature-switch";
import { setDebugLoggerLocalStorage$ } from "../signals/bootstrap/loggers";
import { setPollIntervalForTest$ } from "../signals/zero-page/polling";
import { setSlackPollIntervalForTest$ } from "../signals/zero-page/zero-slack";

export async function setupPage(options: {
  context: TestContext;
  path: string;
  user?: { id: string; fullName: string; email?: string } | null;
  session?: { token: string } | null;
  org?: {
    activeOrg?: { id: string; name: string } | null;
    memberships?: { id: string }[];
  };
  debugLoggers?: string[];
  featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
  withoutRender?: boolean;
}) {
  // in tests we want to control the polling interval to make them faster and deterministic
  // if a test requires a specific interval to run, it indicates that the test is tightly coupled with real-world time. This is a very bad code smell.
  // So you should never try to modify this time interval here just to make a test pass. Instead, try your best to discover the underlying timing issues within the test.
  options.context.store.set(setPollIntervalForTest$, 0);
  options.context.store.set(setSlackPollIntervalForTest$, 0);

  createPushStateMock(options.context.signal);
  pushState({}, "", options.path);

  if (options.debugLoggers) {
    options.context.store.set(
      setDebugLoggerLocalStorage$,
      JSON.stringify(options.debugLoggers ?? []),
    );
  }

  if (options.featureSwitches) {
    options.context.store.set(
      setFeatureSwitchLocalStorage$,
      JSON.stringify(options.featureSwitches),
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

  // Default active org so needsOrgSelection$ doesn't redirect to /select-org.
  // Tests that explicitly configure org state before calling setupPage can pass
  // `org` to override this default (or call mockOrganization() before setupPage).
  if (options.org) {
    mockOrganization(options.org);
  } else {
    mockOrganization({
      activeOrg: { id: "org_default", name: "Default Org" },
      memberships: [{ id: "org_default" }],
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
    // Bootstrap the app (like main.ts does)
    await act(async () => {
      await options.context.store.set(
        bootstrap$,
        () => {
          setupRouter(
            createTestStoreProvider(options.context.store),
            (element) => {
              const { unmount } = render(element);
              options.context.signal.addEventListener("abort", () => {
                unmount();
              });
            },
          );
        },
        options.context.signal,
      );
    });
  }
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
  ) as unknown as typeof window.history.pushState;
  mockPushState(fn, signal);

  const replaceFn = vi.fn(
    (_data: unknown, _unused: string, url?: string | URL | null) => {
      updateLocation(url);
    },
  ) as unknown as typeof window.history.replaceState;
  mockReplaceState(replaceFn, signal);

  return fn;
}

function createTestStoreProvider(store: Store) {
  return function TestStoreProvider({ children }: { children: ReactNode }) {
    return createElement(StoreProvider, { value: store }, children);
  };
}
