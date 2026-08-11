import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  clerkSetup,
  setupClerkTestingToken,
} from "@clerk/testing/playwright";
import { chromium } from "@playwright/test";

import { signInWithClerkTestingHelper } from "./lib/auth";
import { issueCliToken } from "./lib/cli-token";
import { runnerTestAccounts } from "./lib/clerk-api";

interface RunnerCredentialTarget {
  readonly email: string;
  readonly fileName: string;
  readonly organizationId: string;
}

async function main(): Promise<void> {
  requiredEnvironmentVariable("JOB_REF");
  const apiUrl = requiredEnvironmentVariable("VM0_API_BACKEND_URL");
  const appUrl = requiredEnvironmentVariable("ZERO_APP_URL");
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
    },
    {
      email: accounts.codex,
      fileName: "e2e-api-credentials-runner-real-codex.json",
      organizationId: requiredEnvironmentVariable(
        "E2E_RUNNER_CODEX_ORGANIZATION_ID",
      ),
    },
    {
      email: accounts.claude,
      fileName: "e2e-api-credentials-runner-real-claude.json",
      organizationId: requiredEnvironmentVariable(
        "E2E_RUNNER_CLAUDE_ORGANIZATION_ID",
      ),
    },
  ];
  const vercelAutomationBypassSecret =
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

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
        const page = await context.newPage();
        const clerkSessionToken = await signInWithClerkTestingHelper(
          page,
          target.email,
          appUrl,
          { activeOrganizationId: target.organizationId },
        );
        const token = await issueCliToken({
          apiUrl,
          clerkSessionToken,
          vercelAutomationBypassSecret,
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
