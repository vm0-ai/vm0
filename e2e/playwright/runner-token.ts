import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { clerkSetup } from "@clerk/testing/playwright";
import { chromium, type Browser, type Page } from "@playwright/test";

import {
  refreshClerkSessionToken,
  signInWithLoadedClerkTestingHelper,
  withLoadedClerkTestingPage,
} from "./lib/auth";
import { issueCliToken } from "./lib/cli-token";
import { runnerTestAccounts } from "./lib/clerk-api";
import {
  ensureRunnerOrganizationReady,
  startVideoOnboardingCheckout,
  waitForPaidOnboardingCompletion,
} from "./lib/onboarding";
import {
  collectStripeCheckoutState,
  fillStripeCheckout,
} from "./lib/stripe-checkout";

interface RunnerCredentialTarget {
  readonly email: string;
  readonly fileName: string;
  readonly organizationId: string;
  readonly upgradeToPro: boolean;
}

interface ProvisionRunnerCredentialOptions {
  readonly apiUrl: string;
  readonly appUrl: string;
  readonly browser: Browser;
  readonly outputDirectory: string;
  readonly target: RunnerCredentialTarget;
  readonly vercelAutomationBypassSecret?: string;
}

async function main(): Promise<void> {
  requiredEnvironmentVariable("JOB_REF");
  const apiUrl = requiredEnvironmentVariable("VM0_API_BACKEND_URL");
  const appUrl = requiredEnvironmentVariable("OKOU_APP_URL");
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
  const vercelAutomationBypassSecret =
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  await mkdir(outputDirectory, { recursive: true });
  await clerkSetup();
  const browser = await chromium.launch();
  try {
    for (const target of targets) {
      await provisionRunnerCredential({
        apiUrl,
        appUrl,
        browser,
        outputDirectory,
        target,
        vercelAutomationBypassSecret,
      });
    }
  } finally {
    await browser.close();
  }
}

async function provisionRunnerCredential(
  options: ProvisionRunnerCredentialOptions,
): Promise<void> {
  const {
    apiUrl,
    appUrl,
    browser,
    outputDirectory,
    target,
    vercelAutomationBypassSecret,
  } = options;
  let stage = "browser setup";
  try {
    await withLoadedClerkTestingPage(
      browser,
      {
        appUrl,
        contextOptions: {
          ignoreHTTPSErrors: true,
          extraHTTPHeaders: vercelAutomationBypassSecret
            ? {
                "x-vercel-protection-bypass": vercelAutomationBypassSecret,
              }
            : undefined,
        },
      },
      async (page) => {
        stage = "Clerk sign-in";
        let clerkSessionToken = await signInWithLoadedClerkTestingHelper(
          page,
          target.email,
          appUrl,
          { activeOrganizationId: target.organizationId },
        );
        stage = "organization bootstrap";
        await ensureRunnerOrganizationReady({
          apiUrl,
          clerkSessionToken,
          vercelAutomationBypassSecret,
        });
        if (target.upgradeToPro) {
          stage = "paid onboarding";
          await completePaidOnboarding(page, target, appUrl, outputDirectory);
          stage = "Clerk session refresh";
          clerkSessionToken = await refreshClerkSessionToken(page, {
            activeOrganizationId: target.organizationId,
          });
        }
        stage = "CLI authorization";
        const token = await issueCliToken({
          apiUrl,
          clerkSessionToken,
          vercelAutomationBypassSecret,
        });
        const outputFile = join(outputDirectory, target.fileName);
        stage = "credential file write";
        await writeFile(
          outputFile,
          `${JSON.stringify({ token, apiUrl }, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        console.log("Generated runner E2E API credential", {
          email: target.email,
          outputFile,
        });
      },
    );
  } catch (cause: unknown) {
    throw new Error(
      `Failed to provision runner E2E credential for ${target.email} (${target.fileName}) during ${stage}`,
      { cause },
    );
  }
}

async function completePaidOnboarding(
  page: Page,
  target: RunnerCredentialTarget,
  appUrl: string,
  outputDirectory: string,
): Promise<void> {
  await startVideoOnboardingCheckout(page, { appUrl });
  try {
    await fillStripeCheckout(page);
  } catch (error: unknown) {
    try {
      await captureStripeCheckoutFailure(page, target, outputDirectory);
    } catch (diagnosticError: unknown) {
      console.error("Unable to capture Stripe Checkout diagnostics", {
        diagnosticErrorType:
          diagnosticError instanceof Error
            ? diagnosticError.name
            : typeof diagnosticError,
        target: target.fileName,
      });
    }
    throw error;
  }
  await waitForPaidOnboardingCompletion(page, { appUrl });
}

async function captureStripeCheckoutFailure(
  page: Page,
  target: RunnerCredentialTarget,
  outputDirectory: string,
): Promise<void> {
  const diagnosticDirectory = join(
    outputDirectory,
    "e2e-runner-checkout-diagnostics",
  );
  const fileStem = target.fileName.replace(/\.json$/u, "");
  await mkdir(diagnosticDirectory, { recursive: true });

  const results = await Promise.allSettled([
    writeStripeCheckoutState(
      page,
      join(diagnosticDirectory, `${fileStem}.json`),
    ),
    page.screenshot({
      fullPage: true,
      path: join(diagnosticDirectory, `${fileStem}.png`),
    }),
  ]);
  if (!results.some((result) => result.status === "fulfilled")) {
    throw new Error("Unable to capture any Stripe Checkout diagnostic");
  }
}

async function writeStripeCheckoutState(
  page: Page,
  path: string,
): Promise<void> {
  const state = await collectStripeCheckoutState(page);
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
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
