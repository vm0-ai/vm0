import type { Plugin } from "vite";

import {
  type ClerkCoreHtmlOptions,
  transformClerkCoreScriptUrls,
} from "./clerk-html-transform.ts";

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

export function clerkCoreHtmlPlugin(appVersion: string): Plugin {
  let options: ClerkCoreHtmlOptions;
  return {
    name: "platform-clerk-core-html",
    configResolved(config) {
      requiredEnvironmentValue(
        config.env,
        "VITE_CLERK_PUBLISHABLE_KEY_PREVIEW",
      );
      requiredEnvironmentValue(config.env, "VITE_CLERK_PUBLISHABLE_KEY_PROD");
      options = {
        appVersion,
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
