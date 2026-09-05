import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import indexHtml from "../../index.html?raw";
import {
  normalizeClerkProductionPrimaryAppDomain,
  resolveClerkProductionSatelliteDomain,
  resolveClerkProductionTopology,
} from "../lib/clerk-production-topology.ts";
import { setupPage } from "./page-helper.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();

const OKOU_PRIMARY_SATELLITE_LOAD_OPTIONS = {
  afterSignOutUrl: "https://app.okou.ai/sign-in",
  isSatellite: true,
  satelliteAutoSync: true,
  signInUrl: "https://app.okou.ai/sign-in",
  signUpUrl: "https://app.okou.ai/sign-up",
} as const;

const VM0_PRIMARY_LOAD_OPTIONS = {
  afterSignOutUrl: "https://app.vm0.ai/sign-in",
  signInUrl: "https://app.vm0.ai/sign-in",
  signUpUrl: "https://app.vm0.ai/sign-up",
} as const;

const VM0_PRIMARY_SATELLITE_LOAD_OPTIONS = {
  ...VM0_PRIMARY_LOAD_OPTIONS,
  isSatellite: true,
  satelliteAutoSync: true,
} as const;

test("A build that lost the injected primary app domain authenticates against Okou", async () => {
  const clerk = context.mocks.clerk();

  await setupPage({
    context,
    host: "app.vm0.ai",
    path: "/agents",
    primaryAppDomain: null,
  });

  expect(clerk.resourceRequests).toStrictEqual([
    { domain: "vm0.ai", publishableKey: "test_production_key" },
  ]);
  expect(clerk.loads).toContainEqual(OKOU_PRIMARY_SATELLITE_LOAD_OPTIONS);
});

test("The deployed primary app domain keeps vm0.ai a satellite of Okou", async () => {
  const clerk = context.mocks.clerk();

  await setupPage({
    context,
    host: "app.vm0.ai",
    path: "/agents",
    primaryAppDomain: "app.okou.ai",
  });

  expect(clerk.resourceRequests).toStrictEqual([
    { domain: "vm0.ai", publishableKey: "test_production_key" },
  ]);
  expect(clerk.loads).toContainEqual(OKOU_PRIMARY_SATELLITE_LOAD_OPTIONS);
});

// The rollback path: restoring the previous topology must stay a change to the
// injected deployment value, never a code change.
test("An explicitly requested app.vm0.ai still owns primary authentication", async () => {
  const clerk = context.mocks.clerk();

  await setupPage({
    context,
    host: "app.vm0.ai",
    path: "/sign-in",
    auth: null,
    primaryAppDomain: "app.vm0.ai",
  });

  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
  expect(clerk.resourceRequests).toStrictEqual([
    { domain: undefined, publishableKey: "test_production_key" },
  ]);
  expect(clerk.loads).toContainEqual(VM0_PRIMARY_LOAD_OPTIONS);
});

test("An explicitly requested app.vm0.ai keeps Okou a satellite", async () => {
  const clerk = context.mocks.clerk();

  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/agents",
    primaryAppDomain: "app.vm0.ai",
  });

  expect(clerk.resourceRequests).toStrictEqual([
    { domain: "app.okou.ai", publishableKey: "test_production_key" },
  ]);
  expect(clerk.loads).toContainEqual(VM0_PRIMARY_SATELLITE_LOAD_OPTIONS);
});

const BOOTSTRAP_SCRIPT_OPENING_TAG = '<script data-okou-clerk-bootstrap="">';
const PRIMARY_APP_DOMAIN_MARKER = "__VM0_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN__";

interface InlineBootstrapLoadOptions {
  readonly isSatellite?: true;
  readonly signInUrl: string;
}

interface InlineBootstrapConfiguration {
  readonly domain?: string;
  readonly loadOptions: InlineBootstrapLoadOptions;
  readonly productionPrimaryAppDomain: string;
}

interface InlineBootstrapWindow {
  __vm0ClerkBootstrap?: InlineBootstrapConfiguration;
}

interface InlineBootstrapScript {
  dataset: Record<string, string>;
  onerror: (() => void) | null;
  onload: (() => void) | null;
  remove: () => void;
}

type InlineBootstrap = (
  window: InlineBootstrapWindow,
  document: { getElementById: (id: string) => InlineBootstrapScript },
  location: { hostname: string; origin: string },
) => void;

function inlineBootstrapSource(): string {
  const start = indexHtml.indexOf(BOOTSTRAP_SCRIPT_OPENING_TAG);
  const end = indexHtml.indexOf("</script>", start);
  if (start === -1 || end === -1) {
    throw new Error("index.html no longer contains the Clerk bootstrap script");
  }
  return indexHtml.slice(start + BOOTSTRAP_SCRIPT_OPENING_TAG.length, end);
}

// Runs the bootstrap the deployed page runs, with the deployment marker
// substituted the way the worker shell substitutes it.
function runInlineBootstrap(
  injectedPrimaryAppDomain: string,
  hostname: string,
): InlineBootstrapConfiguration {
  const source = inlineBootstrapSource().replaceAll(
    PRIMARY_APP_DOMAIN_MARKER,
    injectedPrimaryAppDomain,
  );
  const runBootstrap = new Function(
    "window",
    "document",
    "location",
    source,
  ) as InlineBootstrap;
  const script: InlineBootstrapScript = {
    dataset: {},
    onerror: null,
    onload: null,
    remove: () => {
      return;
    },
  };
  const bootstrapWindow: InlineBootstrapWindow = {};
  runBootstrap(
    bootstrapWindow,
    {
      getElementById: () => {
        return script;
      },
    },
    { hostname, origin: `https://${hostname}` },
  );
  const bootstrap = bootstrapWindow.__vm0ClerkBootstrap;
  if (!bootstrap) {
    throw new Error("The inline Clerk bootstrap published no configuration");
  }
  return bootstrap;
}

const INJECTED_PRIMARY_APP_DOMAINS = [
  "app.okou.ai",
  "app.vm0.ai",
  // A build that never substituted the marker, and a misspelled substitution.
  PRIMARY_APP_DOMAIN_MARKER,
  "app.okou.ia",
  "",
];

const PAGE_HOSTNAMES = [
  "app.vm0.ai",
  "vm0.ai",
  "www.vm0.ai",
  "app.okou.ai",
  "okou.ai",
  "team.app.okou.ai",
  "app.vm0.ai.evil.example",
  "pr-30199-app.omby.ai",
];

// The page and the app decide the same thing in two languages. A change to one
// without the other is a silent split-brain that type checking cannot catch.
//
// This case cannot be built through the page: no page surface exposes the raw
// bootstrap script, and `setupPage` accepts only the two valid primary app
// domains, so a page test cannot present the unsubstituted marker or a
// misspelled substitution this test exists to pin.
test("The inline Clerk bootstrap and the topology module agree", () => {
  for (const injectedPrimaryAppDomain of INJECTED_PRIMARY_APP_DOMAINS) {
    for (const hostname of PAGE_HOSTNAMES) {
      const bootstrap = runInlineBootstrap(injectedPrimaryAppDomain, hostname);
      const satelliteDomain = resolveClerkProductionSatelliteDomain(
        hostname,
        injectedPrimaryAppDomain,
      );
      const authOrigin = satelliteDomain
        ? resolveClerkProductionTopology(injectedPrimaryAppDomain)
            .primaryAppOrigin
        : `https://${hostname}`;

      expect({
        hostname,
        injectedPrimaryAppDomain,
        pageDomain: bootstrap.domain ?? null,
        pageIsSatellite: bootstrap.loadOptions.isSatellite ?? false,
        pagePrimaryAppDomain: bootstrap.productionPrimaryAppDomain,
        pageSignInUrl: bootstrap.loadOptions.signInUrl,
      }).toStrictEqual({
        hostname,
        injectedPrimaryAppDomain,
        pageDomain: satelliteDomain,
        pageIsSatellite: satelliteDomain !== null,
        pagePrimaryAppDomain: normalizeClerkProductionPrimaryAppDomain(
          injectedPrimaryAppDomain,
        ),
        pageSignInUrl: `${authOrigin}/sign-in`,
      });
    }
  }
});
