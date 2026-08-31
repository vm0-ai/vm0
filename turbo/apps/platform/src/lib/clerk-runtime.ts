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

interface DeferredClerkUI {
  readonly promise: Promise<ClerkUIConstructor>;
  readonly resolve: (value: ClerkUIConstructor) => void;
}

export interface ClerkBrowserRuntime {
  readonly clerk: PlatformClerk;
  readonly ensureUiLoaded: () => Promise<void>;
  readonly loaded: Promise<void>;
}

type EarlyClerkBootstrap = NonNullable<Window["__vm0ClerkBootstrap"]>;

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
  signal: AbortSignal,
): ClerkBrowserRuntime | null {
  const bootstrap = window.__vm0ClerkBootstrap;
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

  const abort = (): void => {
    bootstrap.abortOnboarding();
    bootstrap.rejectClerkUi(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });

  return {
    clerk,
    ensureUiLoaded: createClerkUiLoader(
      {
        domain: options.domain,
        publishableKey: options.publishableKey,
      },
      {
        promise: bootstrap.clerkUiPromise,
        resolve: bootstrap.resolveClerkUi,
      },
    ),
    loaded: bootstrap.loaded,
  };
}

export function takeClerkBootstrapOnboardingStatus(
  clerk: PlatformClerk,
): EarlyClerkBootstrap["onboardingStatusPromise"] {
  const bootstrap = window.__vm0ClerkBootstrap;
  if (!bootstrap || bootstrap.clerk !== clerk) {
    return undefined;
  }
  const promise = bootstrap.onboardingStatusPromise;
  bootstrap.onboardingStatusPromise = undefined;
  return promise;
}

export function startClerkBrowserRuntime(
  options: ClerkRuntimeOptions,
  signal: AbortSignal,
): Promise<ClerkBrowserRuntime> {
  return (async () => {
    await loadClerkJSScript({
      __internal_clerkJSVersion: CLERK_JS_VERSION,
      domain: options.domain,
      publishableKey: options.publishableKey,
    });
    signal.throwIfAborted();
    const clerk = globalProperty("Clerk");
    if (!isBrowserClerk(clerk)) {
      throw new Error("Clerk browser script did not expose a valid runtime");
    }
    const earlyRuntime = adoptEarlyClerkRuntime(clerk, options, signal);
    if (earlyRuntime) {
      return earlyRuntime;
    }

    const clerkUi = createDeferredClerkUI(signal);
    const scriptOptions = {
      domain: options.domain,
      publishableKey: options.publishableKey,
    };
    const ensureUiLoaded = createClerkUiLoader(scriptOptions, clerkUi);
    patchSharedClerkInstance(clerk);
    const loaded = clerk.load({
      ...options.loadOptions,
      ui: { ClerkUI: clerkUi.promise },
    });
    return { clerk, ensureUiLoaded, loaded };
  })();
}
