import { appendFile } from "node:fs/promises";

import {
  createOrganization,
  createUser,
  deleteOrganizationById,
  deleteUserByEmail,
  runnerTestAccounts,
  type RunnerTestAccounts,
} from "./lib/clerk-api";

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
    await cleanupRunnerAccounts(accounts);
  }
}

async function prepareRunnerAccounts(
  runnerAccounts: RunnerTestAccounts,
  jobRef: string,
): Promise<void> {
  await deleteRunnerUsers(runnerAccounts);

  const runnerUserId = await createUser(runnerAccounts.runner);
  const runnerOrganizationId = await createOrganization(
    `e2e-runner-${jobRef}`,
    runnerUserId,
  );
  const codexUserId = await createUser(runnerAccounts.codex);
  const codexOrganizationId = await createOrganization(
    `e2e-runner-real-codex-${jobRef}`,
    codexUserId,
  );
  const claudeUserId = await createUser(runnerAccounts.claude);
  const claudeOrganizationId = await createOrganization(
    `e2e-runner-real-claude-${jobRef}`,
    claudeUserId,
  );

  await appendFile(
    requiredEnvironmentVariable("GITHUB_OUTPUT"),
    [
      `runner-organization-id=${runnerOrganizationId}`,
      `codex-organization-id=${codexOrganizationId}`,
      `claude-organization-id=${claudeOrganizationId}`,
      `runner-email=${runnerAccounts.runner}`,
      `codex-email=${runnerAccounts.codex}`,
      `claude-email=${runnerAccounts.claude}`,
      "",
    ].join("\n"),
    "utf8",
  );

  console.log("Prepared runner E2E accounts", {
    runnerOrganizationId,
    codexOrganizationId,
    claudeOrganizationId,
    ...runnerAccounts,
  });
}

async function cleanupRunnerAccounts(
  runnerAccounts: RunnerTestAccounts,
): Promise<void> {
  const organizationIds = [
    process.env.E2E_RUNNER_ORGANIZATION_ID,
    process.env.E2E_RUNNER_CODEX_ORGANIZATION_ID,
    process.env.E2E_RUNNER_CLAUDE_ORGANIZATION_ID,
  ];
  for (const organizationId of organizationIds) {
    if (organizationId) {
      await deleteOrganizationById(organizationId);
    }
  }

  await deleteRunnerUsers(runnerAccounts);
  console.log("Cleaned up runner E2E accounts");
}

async function deleteRunnerUsers(
  runnerAccounts: RunnerTestAccounts,
): Promise<void> {
  for (const email of Object.values(runnerAccounts)) {
    await deleteUserByEmail(email);
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
