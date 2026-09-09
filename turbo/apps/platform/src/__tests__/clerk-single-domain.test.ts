import { expect, test } from "vitest";

import indexHtml from "../../index.html?raw";
import { setupPage } from "./page-helper.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();

test("Okou production uses its own authentication URLs", async () => {
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
  src?: string;
  dataset: Record<string, string>;
  onerror: (() => void) | null;
  onload: (() => void) | null;
  remove: () => void;
}

type InlineBootstrap = (
  window: InlineBootstrapWindow,
  document: {
    getElementById: (id: string) => InlineBootstrapScript;
    createElement: (tag: string) => InlineBootstrapScript;
    head: { appendChild: (script: InlineBootstrapScript) => void };
  },
  location: { hostname: string; origin: string; pathname: string },
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
function runInlineBootstrap(hostname: string, pathname = "/sign-in") {
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
  const appendedScripts: InlineBootstrapScript[] = [];
  runBootstrap(
    bootstrapWindow,
    {
      getElementById: () => {
        return script;
      },
      createElement: () => ({ ...script }),
      head: {
        appendChild: (uiScript) => {
          appendedScripts.push(uiScript);
        },
      },
    },
    { hostname, origin: `https://${hostname}`, pathname },
  );
  const bootstrap = bootstrapWindow.__okouClerkBootstrap;
  if (!bootstrap) {
    throw new Error("The inline Clerk bootstrap published no configuration");
  }
  return { bootstrap, appendedScripts };
}

const PAGE_HOSTNAMES = [
  "app.okou.ai",
  "okou.ai",
  "team.app.okou.ai",
  "app.okou.ai.evil.example",
  "pr-30199-app.omby.ai",
];

test("The inline Clerk bootstrap uses the current page sign-in URL", () => {
  for (const hostname of PAGE_HOSTNAMES) {
    const { bootstrap } = runInlineBootstrap(hostname);

    expect({
      hostname,
      pageSignInUrl: bootstrap.loadOptions.signInUrl,
    }).toStrictEqual({
      hostname,
      pageSignInUrl: `https://${hostname}/sign-in`,
    });
  }
});

test("The inline bootstrap loads installed UI only for v1 auth routes", () => {
  for (const pathname of [
    "/agents",
    "/sign-in",
    "/sign-up",
    "/v1/sign-invader",
  ]) {
    expect(
      runInlineBootstrap("app.okou.ai", pathname).appendedScripts,
    ).toStrictEqual([]);
  }
  for (const pathname of [
    "/v1/sign-in",
    "/v1/sign-in/tasks/choose-organization",
    "/v1/sign-up",
    "/v1/sign-up/tasks/choose-organization",
  ]) {
    const { appendedScripts } = runInlineBootstrap("app.okou.ai", pathname);
    expect(appendedScripts).toHaveLength(1);
    expect(appendedScripts[0]?.src).toBe("__OKOU_CLERK_UI_SCRIPT_URL__");
  }
});
