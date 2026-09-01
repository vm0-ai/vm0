import { CLERK_JS_VERSION } from "../src/lib/clerk-versions.ts";

const CLERK_BROWSER_SCRIPT_URL_MARKER = "__VM0_CLERK_BROWSER_SCRIPT_URL__";
const APP_VERSION_JSON_MARKER = "__VM0_APP_VERSION_JSON__";
const CLERK_BROWSER_SCRIPT_URL = `https://cdn.jsdelivr.net/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`;

export interface ClerkCoreHtmlOptions {
  readonly appVersion: string;
}

export function transformClerkCoreScriptUrls(
  html: string,
  options: ClerkCoreHtmlOptions,
): string {
  return html
    .replaceAll(
      APP_VERSION_JSON_MARKER,
      JSON.stringify(options.appVersion).replaceAll("<", String.raw`\u003c`),
    )
    .replaceAll(CLERK_BROWSER_SCRIPT_URL_MARKER, CLERK_BROWSER_SCRIPT_URL);
}
