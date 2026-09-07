import {
  loadClerkJSScript,
  loadClerkUIScript,
} from "@clerk/shared/loadClerkJsScript";
import type { BrowserClerk, EnvironmentResource } from "@clerk/shared/types";
import type { ClerkUIConstructor } from "@clerk/shared/ui";
import { createDeferredPromise } from "../signals/utils.ts";
import { CLERK_JS_VERSION, CLERK_UI_VERSION } from "./clerk-versions.ts";

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

interface ClerkBrowserRuntime {
  readonly clerk: PlatformClerk;
  /**
   * Loads the hosted Clerk UI and hands its constructor to the shared core.
   * Only v1 comparison routes request it, so stable routes keep the core-only
   * download.
   */
  readonly ensureUiLoaded: () => Promise<void>;
  readonly loaded: Promise<void>;
}

type EarlyClerkBootstrap = NonNullable<Window["__okouClerkBootstrap"]>;
type ResolveClerkUI = EarlyClerkBootstrap["resolveClerkUI"];

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
  resolveClerkUI: ResolveClerkUI,
): () => Promise<void> {
  let loadPromise: Promise<void> | undefined;
  return () => {
    loadPromise ??= (async () => {
      await loadClerkUIScript({
        __internal_clerkUIVersion: CLERK_UI_VERSION,
        domain: options.domain,
        publishableKey: options.publishableKey,
      });
      const constructor: unknown = Reflect.get(
        globalThis,
        "__internal_ClerkUICtor",
      );
      if (!isClerkUIConstructor(constructor)) {
        throw new Error("Clerk UI script did not expose a valid constructor");
      }
      resolveClerkUI(constructor);
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

function matchesEarlyLoadOptions(
  early: EarlyClerkBootstrap["loadOptions"],
  current: ClerkRuntimeLoadOptions,
): boolean {
  return (
    early.afterSignOutUrl === current.afterSignOutUrl &&
    early.isSatellite === current.isSatellite &&
    early.satelliteAutoSync === current.satelliteAutoSync &&
    early.signInUrl === current.signInUrl &&
    early.signUpUrl === current.signUpUrl
  );
}

function adoptEarlyClerkRuntime(
  clerk: PlatformClerk,
  options: ClerkRuntimeOptions,
  scriptOptions: ClerkScriptOptions,
): ClerkBrowserRuntime | null {
  const bootstrap = window.__okouClerkBootstrap;
  if (!bootstrap?.loaded || bootstrap.clerk !== clerk) {
    return null;
  }
  if (
    bootstrap.publishableKey !== options.publishableKey ||
    bootstrap.domain !== options.domain ||
    !matchesEarlyLoadOptions(bootstrap.loadOptions, options.loadOptions)
  ) {
    throw new Error("Early Clerk bootstrap configuration mismatch");
  }

  const loaded = bootstrap.loaded;
  bootstrap.loaded = undefined;

  return {
    clerk,
    ensureUiLoaded: createClerkUiLoader(
      scriptOptions,
      bootstrap.resolveClerkUI,
    ),
    loaded,
  };
}

/**
 * `signal` owns the hosted UI handle handed to Clerk core. Clerk keeps that
 * promise for the lifetime of the shared browser runtime, so only the app
 * root may abort it; route and command signals must not.
 */
export async function startClerkBrowserRuntime(
  options: ClerkRuntimeOptions,
  signal: AbortSignal,
): Promise<ClerkBrowserRuntime> {
  const scriptOptions: ClerkScriptOptions = {
    domain: options.domain,
    publishableKey: options.publishableKey,
  };
  await loadClerkJSScript({
    __internal_clerkJSVersion: CLERK_JS_VERSION,
    domain: options.domain,
    publishableKey: options.publishableKey,
  });
  const clerk: unknown = Reflect.get(globalThis, "Clerk");
  if (!isBrowserClerk(clerk)) {
    throw new Error("Clerk browser script did not expose a valid runtime");
  }
  const earlyRuntime = adoptEarlyClerkRuntime(clerk, options, scriptOptions);
  if (earlyRuntime) {
    return earlyRuntime;
  }

  patchSharedClerkInstance(clerk);
  // Clerk accepts the UI constructor as a promise, so core initialization does
  // not wait for a download that most routes never need.
  const clerkUI = createDeferredPromise<ClerkUIConstructor>(signal);
  const loaded = clerk.load({
    ...options.loadOptions,
    ui: { ClerkUI: clerkUI.promise },
  });
  return {
    clerk,
    ensureUiLoaded: createClerkUiLoader(scriptOptions, clerkUI.resolve),
    loaded,
  };
}
