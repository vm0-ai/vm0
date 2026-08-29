import { clerkJSScriptUrl } from "@clerk/shared/loadClerkJsScript";
import type { Plugin } from "vite";

import { CLERK_JS_VERSION } from "../src/lib/clerk-versions.ts";

const PREVIEW_SCRIPT_URL_MARKER = "__VM0_CLERK_PREVIEW_SCRIPT_URL__";
const PRODUCTION_SCRIPT_URL_MARKER = "__VM0_CLERK_PRODUCTION_SCRIPT_URL__";
const SATELLITE_SCRIPT_URL_MARKER = "__VM0_CLERK_SATELLITE_SCRIPT_URL__";
const PRODUCTION_SATELLITE_DOMAIN = "app.okou.ai";

interface ClerkCoreHtmlOptions {
  readonly previewPublishableKey: string;
  readonly productionPublishableKey: string;
}

function requiredEnvironmentValue(
  environment: Record<string, unknown>,
  name: string,
): string {
  const value = environment[name];
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing ${name} environment variable`);
  }
  return value;
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

export function clerkCoreHtmlPlugin(): Plugin {
  let options: ClerkCoreHtmlOptions;
  return {
    name: "platform-clerk-core-html",
    configResolved(config) {
      options = {
        previewPublishableKey: requiredEnvironmentValue(
          config.env,
          "VITE_CLERK_PUBLISHABLE_KEY_PREVIEW",
        ),
        productionPublishableKey: requiredEnvironmentValue(
          config.env,
          "VITE_CLERK_PUBLISHABLE_KEY_PROD",
        ),
      };
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return transformClerkCoreScriptUrls(html, options);
      },
    },
  };
}
