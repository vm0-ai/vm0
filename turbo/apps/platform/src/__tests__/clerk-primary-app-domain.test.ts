import { expect, test } from "vitest";

import indexHtml from "../../index.html?raw";
import {
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

test("vm0.ai is a satellite of Okou", async () => {
  const clerk = context.mocks.clerk();

  await setupPage({
    context,
    host: "app.vm0.ai",
    path: "/agents",
  });

  expect(clerk.resourceRequests).toStrictEqual([
    { domain: "vm0.ai", publishableKey: "test_production_key" },
  ]);
  expect(clerk.loads).toContainEqual(OKOU_PRIMARY_SATELLITE_LOAD_OPTIONS);
});

const BOOTSTRAP_SCRIPT_SELECTOR = "[data-okou-clerk-bootstrap]";

interface InlineBootstrapLoadOptions {
  readonly isSatellite?: true;
  readonly signInUrl: string;
}

interface InlineBootstrapConfiguration {
  readonly domain?: string;
  readonly loadOptions: InlineBootstrapLoadOptions;
}

interface InlineBootstrapWindow {
  __okouClerkBootstrap?: InlineBootstrapConfiguration;
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
  const page = new DOMParser().parseFromString(indexHtml, "text/html");
  const source = page.querySelector(BOOTSTRAP_SCRIPT_SELECTOR)?.textContent;
  if (!source) {
    throw new Error("index.html no longer contains the Clerk bootstrap script");
  }
  return source;
}

// Runs the bootstrap the deployed page runs.
function runInlineBootstrap(hostname: string): InlineBootstrapConfiguration {
  const source = inlineBootstrapSource();
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
  const bootstrap = bootstrapWindow.__okouClerkBootstrap;
  if (!bootstrap) {
    throw new Error("The inline Clerk bootstrap published no configuration");
  }
  return bootstrap;
}

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
// bootstrap script.
test("The inline Clerk bootstrap and the topology module agree", () => {
  for (const hostname of PAGE_HOSTNAMES) {
    const bootstrap = runInlineBootstrap(hostname);
    const satelliteDomain = resolveClerkProductionSatelliteDomain(hostname);
    const authOrigin = satelliteDomain
      ? resolveClerkProductionTopology().primaryAppOrigin
      : `https://${hostname}`;

    expect({
      hostname,
      pageDomain: bootstrap.domain ?? null,
      pageIsSatellite: bootstrap.loadOptions.isSatellite ?? false,
      pageSignInUrl: bootstrap.loadOptions.signInUrl,
    }).toStrictEqual({
      hostname,
      pageDomain: satelliteDomain,
      pageIsSatellite: satelliteDomain !== null,
      pageSignInUrl: `${authOrigin}/sign-in`,
    });
  }
});
