import {
  loadClerkJSScript,
  loadClerkUIScript,
} from "@clerk/shared/loadClerkJsScript";
import type { BrowserClerk, EnvironmentResource } from "@clerk/shared/types";
import type { ClerkUIConstructor } from "@clerk/shared/ui";
import { createDeferredPromise } from "../signals/utils.ts";

const CLERK_JS_VERSION = "6.25.8";
const CLERK_UI_VERSION = "1.27.0";

interface ClerkRuntimeOptions {
  readonly publishableKey: string;
  readonly domain?: string;
  readonly loadOptions: ClerkRuntimeLoadOptions;
}

interface ClerkRuntimeLoadOptions {
  readonly afterSignOutUrl: string;
  readonly isSatellite?: true;
  readonly satelliteAutoSync?: true;
  readonly signInUrl: string;
  readonly signUpUrl: string;
}

interface ClerkScriptOptions {
  readonly publishableKey: string;
  readonly domain?: string;
}

interface DeferredClerkUI {
  readonly promise: Promise<ClerkUIConstructor>;
  readonly resolve: (value: ClerkUIConstructor) => void;
}

export interface ClerkBrowserRuntime {
  readonly clerk: PlatformClerk;
  readonly ensureUiLoaded: () => Promise<void>;
  readonly loaded: Promise<void>;
}

/**
 * Clerk keeps this promise for the lifetime of the shared browser runtime and
 * reads it only when hosted UI is mounted. The app root owns that runtime;
 * route and command signals must not abort it independently.
 */
function createDeferredClerkUI(signal: AbortSignal): DeferredClerkUI {
  const { promise, resolve } =
    createDeferredPromise<ClerkUIConstructor>(signal);
  return { promise, resolve };
}

function globalProperty(name: string): unknown {
  return Reflect.get(globalThis, name);
}

export type PlatformClerk = BrowserClerk & {
  readonly __internal_environment?: EnvironmentResource;
};

function isBrowserClerk(value: unknown): value is PlatformClerk {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "load") === "function" &&
    typeof Reflect.get(value, "on") === "function"
  );
}

function isClerkUIConstructor(value: unknown): value is ClerkUIConstructor {
  return typeof value === "function";
}

function createClerkUiLoader(
  options: ClerkScriptOptions,
  clerkUi: DeferredClerkUI,
): () => Promise<void> {
  let loadPromise: Promise<void> | undefined;
  return () => {
    loadPromise ??= (async () => {
      await loadClerkUIScript({
        __internal_clerkUIVersion: CLERK_UI_VERSION,
        domain: options.domain,
        publishableKey: options.publishableKey,
      });
      const constructor = globalProperty("__internal_ClerkUICtor");
      if (!isClerkUIConstructor(constructor)) {
        throw new Error("Clerk UI script did not expose a valid constructor");
      }
      clerkUi.resolve(constructor);
    })();
    return loadPromise;
  };
}

function patchSharedClerkInstance(clerk: PlatformClerk): void {
  // @clerk/react subscribes in a passive effect without requesting the current
  // value. Replaying status prevents a provider mounted after core bootstrap
  // from remaining in its loading fallback.
  const subscribeToStatus = clerk.on.bind(clerk);
  clerk.on = (event, handler, options) => {
    subscribeToStatus(event, handler, { ...options, notify: true });
  };

  // Signals and the route-scoped React provider share this browser instance.
  // Keep all callers on the first initialization request.
  const loadClerk = clerk.load.bind(clerk);
  let loadPromise: Promise<void> | undefined;
  clerk.load = (options) => {
    loadPromise ??= loadClerk(options);
    return loadPromise;
  };
}

export function startClerkBrowserRuntime(
  options: ClerkRuntimeOptions,
  signal: AbortSignal,
): Promise<ClerkBrowserRuntime> {
  const clerkUi = createDeferredClerkUI(signal);
  const scriptOptions = {
    domain: options.domain,
    publishableKey: options.publishableKey,
  };
  const ensureUiLoaded = createClerkUiLoader(scriptOptions, clerkUi);
  return (async () => {
    await loadClerkJSScript({
      __internal_clerkJSVersion: CLERK_JS_VERSION,
      domain: options.domain,
      publishableKey: options.publishableKey,
    });
    const clerk = globalProperty("Clerk");
    if (!isBrowserClerk(clerk)) {
      throw new Error("Clerk browser script did not expose a valid runtime");
    }
    patchSharedClerkInstance(clerk);
    const loaded = clerk.load({
      ...options.loadOptions,
      ui: { ClerkUI: clerkUi.promise },
    });
    return { clerk, ensureUiLoaded, loaded };
  })();
}
