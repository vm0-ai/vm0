import { appendFile } from "node:fs/promises";

import {
  cleanupCurrentClerkTestGeneration,
  cleanupCurrentClerkTestRun,
  createOrganization,
  createUser,
  runnerTestAccounts,
  type ClerkTestRole,
  type RunnerTestAccounts,
} from "./lib/clerk-api";

const RUNNER_TEST_ROLES = [
  "runner",
  "runner-real-codex",
  "runner-real-claude",
  "runner-mock-claude",
] as const satisfies readonly ClerkTestRole[];

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "prepare":
      await prepareRunnerAccounts(
        runnerTestAccounts(),
        requiredEnvironmentVariable("JOB_REF"),
      );
      break;
    case "cleanup-generation":
      await cleanupRunnerAccountGeneration();
      break;
    case "cleanup-run":
      await cleanupRunnerAccountRun();
      break;
    default:
      throw new Error(
        "Usage: runner-account.ts <prepare|cleanup-generation|cleanup-run>",
      );
  }
}

async function prepareRunnerAccounts(
  runnerAccounts: RunnerTestAccounts,
  jobRef: string,
): Promise<void> {
  try {
    const runnerUserId = await createUser(runnerAccounts.runner);
    const runnerOrganizationId = await createOrganization(
      `e2e-runner-${jobRef}`,
      runnerUserId,
      "runner",
    );
    const codexUserId = await createUser(runnerAccounts.codex);
    const codexOrganizationId = await createOrganization(
      `e2e-runner-real-codex-${jobRef}`,
      codexUserId,
      "runner-real-codex",
    );
    const claudeUserId = await createUser(runnerAccounts.claude);
    const claudeOrganizationId = await createOrganization(
      `e2e-runner-real-claude-${jobRef}`,
      claudeUserId,
      "runner-real-claude",
    );
    const mockClaudeUserId = await createUser(runnerAccounts.mockClaude);
    const mockClaudeOrganizationId = await createOrganization(
      `e2e-runner-mock-claude-${jobRef}`,
      mockClaudeUserId,
      "runner-mock-claude",
    );

    await appendFile(
      requiredEnvironmentVariable("GITHUB_OUTPUT"),
      [
        `runner-organization-id=${runnerOrganizationId}`,
        `codex-organization-id=${codexOrganizationId}`,
        `claude-organization-id=${claudeOrganizationId}`,
        `mock-claude-organization-id=${mockClaudeOrganizationId}`,
        `runner-email=${runnerAccounts.runner}`,
        `codex-email=${runnerAccounts.codex}`,
        `claude-email=${runnerAccounts.claude}`,
        `mock-claude-email=${runnerAccounts.mockClaude}`,
        "",
      ].join("\n"),
      "utf8",
    );

    console.log("Prepared runner E2E accounts", {
      runnerOrganizationId,
      codexOrganizationId,
      claudeOrganizationId,
      mockClaudeOrganizationId,
      ...runnerAccounts,
    });
  } catch (cause) {
    await cleanupRunnerAccountGeneration();
    throw cause;
  }
}

async function cleanupRunnerAccountGeneration(): Promise<void> {
  const result = await cleanupCurrentClerkTestGeneration(RUNNER_TEST_ROLES);
  console.log("Cleaned up runner E2E account generation", result);
}

async function cleanupRunnerAccountRun(): Promise<void> {
  const result = await cleanupCurrentClerkTestRun(RUNNER_TEST_ROLES);
  console.log("Cleaned up runner E2E workflow run", result);
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
