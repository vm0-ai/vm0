import { expect, test } from "vitest";

import indexHtml from "../../index.html?raw";
import { setupPage } from "./page-helper.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();

test("Okou production authenticates against itself without a satellite", async () => {
  const clerk = context.mocks.clerk();

  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/agents",
  });

  expect(clerk.resourceRequests).toStrictEqual([
    { domain: undefined, publishableKey: "test_production_key" },
  ]);
  expect(clerk.loads).toContainEqual({
    afterSignOutUrl: "https://app.okou.ai/sign-in",
    signInUrl: "https://app.okou.ai/sign-in",
    signUpUrl: "https://app.okou.ai/sign-up",
  });
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

/** Runs the bootstrap the deployed page runs. */
function runInlineBootstrap(hostname: string): InlineBootstrapConfiguration {
  const runBootstrap = new Function(
    "window",
    "document",
    "location",
    inlineBootstrapSource(),
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
  "app.okou.ai",
  "okou.ai",
  "team.app.okou.ai",
  "app.okou.ai.evil.example",
  "pr-30199-app.omby.ai",
];

// Only one domain serves the app, so every page authenticates against itself.
// The page and the app decide this in two languages; a change to one without
// the other is a silent split-brain that type checking cannot catch.
test("The inline Clerk bootstrap never configures a satellite", () => {
  for (const hostname of PAGE_HOSTNAMES) {
    const bootstrap = runInlineBootstrap(hostname);

    expect({
      hostname,
      pageDomain: bootstrap.domain ?? null,
      pageIsSatellite: bootstrap.loadOptions.isSatellite ?? false,
      pageSignInUrl: bootstrap.loadOptions.signInUrl,
    }).toStrictEqual({
      hostname,
      pageDomain: null,
      pageIsSatellite: false,
      pageSignInUrl: `https://${hostname}/sign-in`,
    });
  }
});
