import type { Plugin } from "vite";

import { transformClerkCoreScriptUrls } from "./clerk-html-transform.ts";

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

export function clerkCoreHtmlPlugin(): Plugin {
  return {
    name: "platform-clerk-core-html",
    configResolved(config) {
      requiredEnvironmentValue(
        config.env,
        "VITE_CLERK_PUBLISHABLE_KEY_PREVIEW",
      );
      requiredEnvironmentValue(config.env, "VITE_CLERK_PUBLISHABLE_KEY_PROD");
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return transformClerkCoreScriptUrls(html);
      },
    },
  };
}
