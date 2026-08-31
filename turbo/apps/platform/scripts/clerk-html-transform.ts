import { clerkJSScriptUrl } from "@clerk/shared/loadClerkJsScript";

import { CLERK_JS_VERSION } from "../src/lib/clerk-versions.ts";

const PREVIEW_SCRIPT_URL_MARKER = "__VM0_CLERK_PREVIEW_SCRIPT_URL__";
const PRODUCTION_SCRIPT_URL_MARKER = "__VM0_CLERK_PRODUCTION_SCRIPT_URL__";
const SATELLITE_SCRIPT_URL_MARKER = "__VM0_CLERK_SATELLITE_SCRIPT_URL__";
const PRODUCTION_SATELLITE_DOMAIN = "app.okou.ai";

export interface ClerkCoreHtmlOptions {
  readonly previewPublishableKey: string;
  readonly productionPublishableKey: string;
}

function scriptUrl(publishableKey: string, domain?: string): string {
  return clerkJSScriptUrl({
    __internal_clerkJSVersion: CLERK_JS_VERSION,
    domain,
    publishableKey,
  });
}

export function transformClerkCoreScriptUrls(
  html: string,
  options: ClerkCoreHtmlOptions,
): string {
  return html
    .replaceAll(
      PREVIEW_SCRIPT_URL_MARKER,
      scriptUrl(options.previewPublishableKey),
    )
    .replaceAll(
      PRODUCTION_SCRIPT_URL_MARKER,
      scriptUrl(options.productionPublishableKey),
    )
    .replaceAll(
      SATELLITE_SCRIPT_URL_MARKER,
      scriptUrl(options.productionPublishableKey, PRODUCTION_SATELLITE_DOMAIN),
    );
}
