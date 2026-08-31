import type { Page } from "@playwright/test";

export async function waitForActiveAgentId(page: Page): Promise<string> {
  await page.waitForURL(/\/agents\/[^/]+\/chat\/?$/, { timeout: 30_000 });
  const agentId = new URL(page.url()).pathname.match(
    /^\/agents\/([^/]+)\/chat\/?$/,
  )?.[1];
  if (!agentId) {
    throw new Error("Could not resolve the active agent from the chat URL");
  }
  return agentId;
}
