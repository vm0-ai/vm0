import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { chromium } from "@playwright/test";

import {
  refreshClerkSessionToken,
  signInWithClerkTestingHelper,
} from "./lib/auth";
import {
  apiPreviewHeaders,
  installApiPreviewHeadersForUrl,
} from "./lib/api-preview-auth";
import { issueCliToken } from "./lib/cli-token";
import { runnerTestAccounts } from "./lib/clerk-api";
import {
  startVideoOnboardingCheckout,
  waitForPaidOnboardingCompletion,
} from "./lib/onboarding";
import { fillStripeCheckout } from "./lib/stripe-checkout";

interface RunnerCredentialTarget {
  readonly email: string;
  readonly fileName: string;
  readonly organizationId: string;
  readonly upgradeToPro: boolean;
}

async function main(): Promise<void> {
  requiredEnvironmentVariable("JOB_REF");
  const apiUrl = requiredEnvironmentVariable("VM0_API_BACKEND_URL");
  const appUrl =
    process.env.OKOU_APP_URL || requiredEnvironmentVariable("ZERO_APP_URL");
  const outputDirectory = process.argv[2];
  if (!outputDirectory) {
    throw new Error("Usage: runner-token.ts <output-directory>");
  }

  const accounts = runnerTestAccounts();
  const targets: readonly RunnerCredentialTarget[] = [
    {
      email: accounts.runner,
      fileName: "e2e-api-credentials-runner.json",
      organizationId: requiredEnvironmentVariable("E2E_RUNNER_ORGANIZATION_ID"),
      upgradeToPro: false,
    },
    {
      email: accounts.codex,
      fileName: "e2e-api-credentials-runner-real-codex.json",
      organizationId: requiredEnvironmentVariable(
        "E2E_RUNNER_CODEX_ORGANIZATION_ID",
      ),
      upgradeToPro: true,
    },
    {
      email: accounts.claude,
      fileName: "e2e-api-credentials-runner-real-claude.json",
      organizationId: requiredEnvironmentVariable(
        "E2E_RUNNER_CLAUDE_ORGANIZATION_ID",
      ),
      upgradeToPro: true,
    },
    {
      email: accounts.mockClaude,
      fileName: "e2e-api-credentials-runner-mock-claude.json",
      organizationId: requiredEnvironmentVariable(
        "E2E_RUNNER_MOCK_CLAUDE_ORGANIZATION_ID",
      ),
      upgradeToPro: true,
    },
  ];
  const previewHeaders = apiPreviewHeaders();
  const vercelAutomationBypassSecret =
    previewHeaders["x-vercel-protection-bypass"];

  await mkdir(outputDirectory, { recursive: true });
  await clerkSetup();
  const browser = await chromium.launch();
  try {
    for (const target of targets) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: vercelAutomationBypassSecret
          ? {
              "x-vercel-protection-bypass": vercelAutomationBypassSecret,
            }
          : undefined,
      });
      try {
        await setupClerkTestingToken({ context });
        await installApiPreviewHeadersForUrl(context, apiUrl);
        const page = await context.newPage();
        let clerkSessionToken = await signInWithClerkTestingHelper(
          page,
          target.email,
          appUrl,
          { activeOrganizationId: target.organizationId },
        );
        if (target.upgradeToPro) {
          await startVideoOnboardingCheckout(page, { appUrl });
          await fillStripeCheckout(page);
          await waitForPaidOnboardingCompletion(page, { appUrl });
          clerkSessionToken = await refreshClerkSessionToken(page, {
            activeOrganizationId: target.organizationId,
          });
        }
        const token = await issueCliToken({
          apiPreviewHeaders: previewHeaders,
          apiUrl,
          clerkSessionToken,
        });
        const outputFile = join(outputDirectory, target.fileName);
        await writeFile(
          outputFile,
          `${JSON.stringify({ token, apiUrl }, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        console.log("Generated runner E2E API credential", {
          email: target.email,
          outputFile,
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
