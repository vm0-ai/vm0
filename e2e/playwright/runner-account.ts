import { appendFile } from "node:fs/promises";

import {
  cleanupCurrentClerkTestGeneration,
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
  if (command !== "prepare" && command !== "cleanup") {
    throw new Error("Usage: runner-account.ts <prepare|cleanup>");
  }

  const jobRef = requiredEnvironmentVariable("JOB_REF");
  const accounts = runnerTestAccounts();

  if (command === "prepare") {
    await prepareRunnerAccounts(accounts, jobRef);
  } else {
    await cleanupRunnerAccounts();
  }
}

async function prepareRunnerAccounts(
  runnerAccounts: RunnerTestAccounts,
  jobRef: string,
): Promise<void> {
  try {
    const runnerOrganizationIds: string[] = [];
    for (const [index, email] of runnerAccounts.runners.entries()) {
      const runnerUserId = await createUser(email);
      runnerOrganizationIds.push(
        await createOrganization(
          `e2e-runner-${index + 1}-${jobRef}`,
          runnerUserId,
          "runner",
        ),
      );
    }
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
        `runner-organization-ids=${JSON.stringify(runnerOrganizationIds)}`,
        `codex-organization-id=${codexOrganizationId}`,
        `claude-organization-id=${claudeOrganizationId}`,
        `mock-claude-organization-id=${mockClaudeOrganizationId}`,
        `runner-emails=${JSON.stringify(runnerAccounts.runners)}`,
        `codex-email=${runnerAccounts.codex}`,
        `claude-email=${runnerAccounts.claude}`,
        `mock-claude-email=${runnerAccounts.mockClaude}`,
        "",
      ].join("\n"),
      "utf8",
    );

    console.log("Prepared runner E2E accounts", {
      runnerOrganizationIds,
      codexOrganizationId,
      claudeOrganizationId,
      mockClaudeOrganizationId,
      runnerEmails: runnerAccounts.runners,
      codexEmail: runnerAccounts.codex,
      claudeEmail: runnerAccounts.claude,
      mockClaudeEmail: runnerAccounts.mockClaude,
    });
  } catch (cause) {
    await cleanupRunnerAccounts();
    throw cause;
  }
}

async function cleanupRunnerAccounts(): Promise<void> {
  const result = await cleanupCurrentClerkTestGeneration(RUNNER_TEST_ROLES);
  console.log("Cleaned up runner E2E accounts", result);
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
