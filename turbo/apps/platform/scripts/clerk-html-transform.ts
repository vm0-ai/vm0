import { CLERK_JS_VERSION } from "../src/lib/clerk-versions.ts";

const CLERK_BROWSER_SCRIPT_URL_MARKER = "__OKOU_CLERK_BROWSER_SCRIPT_URL__";
const CLERK_BROWSER_SCRIPT_URL = `https://cdn.jsdelivr.net/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`;

export function transformClerkCoreScriptUrls(html: string): string {
  return html.replaceAll(
    CLERK_BROWSER_SCRIPT_URL_MARKER,
    CLERK_BROWSER_SCRIPT_URL,
  );
}
