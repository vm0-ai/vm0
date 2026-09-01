import { loadClerkJSScript } from "@clerk/shared/loadClerkJsScript";
import type { BrowserClerk, EnvironmentResource } from "@clerk/shared/types";
import { CLERK_JS_VERSION } from "./clerk-versions.ts";

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

export interface ClerkBrowserRuntime {
  readonly clerk: PlatformClerk;
  readonly loaded: Promise<void>;
}

type EarlyClerkBootstrap = NonNullable<Window["__vm0ClerkBootstrap"]>;

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

  const loaded = bootstrap.loaded;
  bootstrap.loaded = undefined;

  return {
    clerk,
    loaded,
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
): Promise<ClerkBrowserRuntime> {
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
    const earlyRuntime = adoptEarlyClerkRuntime(clerk, options);
    if (earlyRuntime) {
      return earlyRuntime;
    }

    patchSharedClerkInstance(clerk);
    const loaded = clerk.load(options.loadOptions);
    return { clerk, loaded };
  })();
}
