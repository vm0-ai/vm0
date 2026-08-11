import { appendFile } from "node:fs/promises";

import {
  createOrganization,
  createOrganizationMembership,
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
  const codexUserId = await createUser(runnerAccounts.codex);
  const claudeUserId = await createUser(runnerAccounts.claude);
  const organizationId = await createOrganization(
    `Runner E2E ${jobRef}`,
    runnerUserId,
  );

  await appendFile(
    requiredEnvironmentVariable("GITHUB_OUTPUT"),
    [
      `organization-id=${organizationId}`,
      `runner-email=${runnerAccounts.runner}`,
      `codex-email=${runnerAccounts.codex}`,
      `claude-email=${runnerAccounts.claude}`,
      "",
    ].join("\n"),
    "utf8",
  );

  await createOrganizationMembership(organizationId, codexUserId);
  await createOrganizationMembership(organizationId, claudeUserId);

  console.log("Prepared runner E2E accounts", {
    organizationId,
    ...runnerAccounts,
  });
}

async function cleanupRunnerAccounts(
  runnerAccounts: RunnerTestAccounts,
): Promise<void> {
  const organizationId = process.env.E2E_RUNNER_ORGANIZATION_ID;
  if (organizationId) {
    await deleteOrganizationById(organizationId);
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
