import { createElement, type ReactNode } from "react";
import { act, render } from "@testing-library/react";
import type { Store } from "ccstate";
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
import { vi } from "vitest";
import type { FeatureSwitchKey } from "@vm0/core";
import { setFeatureSwitchLocalStorage$ } from "../signals/external/feature-switch";
import { setDebugLoggerLocalStorage$ } from "../signals/bootstrap/loggers";

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
