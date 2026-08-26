import {
  cleanupClerkTestJobRef,
  cleanupCurrentClerkTestGeneration,
  cleanupStaleClerkTestResources,
  currentClerkTestJobRef,
  parseClerkTestRole,
  type ClerkCleanupResult,
  type ClerkTestRole,
} from "./lib/clerk-api";

const STALE_CI_CLEANUP_ARGUMENT = "--ci-older-than-hours";
const STALE_STAGING_BROWSER_CLEANUP_ARGUMENT =
  "--staging-browser-older-than-hours";

async function main(): Promise<void> {
  const command = process.argv[2];
  const dryRun = parseDryRun();
  let result: ClerkCleanupResult;

  switch (command) {
    case "cleanup-generation": {
      const roles = parseRoles(requiredArgument(3, "role list"));
      assertNoExtraArguments(4);
      result = await cleanupCurrentClerkTestGeneration(roles, { dryRun });
      break;
    }
    case "cleanup-job-ref":
      assertNoExtraArguments(3);
      result = await cleanupClerkTestJobRef(currentClerkTestJobRef(), {
        dryRun,
      });
      break;
    case "cleanup-stale": {
      const roles = parseRoles(requiredArgument(3, "role list"));
      if (process.argv[4] !== STALE_CI_CLEANUP_ARGUMENT) {
        throw new Error(
          `cleanup-stale requires <roles> ${STALE_CI_CLEANUP_ARGUMENT} <hours>`,
        );
      }
      const ciCreatedBefore = staleCutoff(requiredArgument(5, "stale CI age"));
      if (process.argv[6] !== STALE_STAGING_BROWSER_CLEANUP_ARGUMENT) {
        throw new Error(
          `cleanup-stale requires <roles> ${STALE_CI_CLEANUP_ARGUMENT} <hours> ${STALE_STAGING_BROWSER_CLEANUP_ARGUMENT} <hours>`,
        );
      }
      const stagingBrowserCreatedBefore = staleCutoff(
        requiredArgument(7, "stale staging browser age"),
      );
      assertNoExtraArguments(8);
      result = await cleanupStaleClerkTestResources(roles, ciCreatedBefore, {
        dryRun,
        stagingBrowserCreatedBefore,
      });
      break;
    }
    default:
      throw new Error(
        "Usage: clerk-test-resources.ts cleanup-generation <roles> | cleanup-job-ref | cleanup-stale <roles> --ci-older-than-hours <hours> --staging-browser-older-than-hours <hours>",
      );
  }

  console.log("Clerk test resource cleanup", {
    dryRun,
    ...result,
  });
}

function parseRoles(value: string): readonly ClerkTestRole[] {
  const roles: ClerkTestRole[] = [];
  for (const roleValue of value.split(",")) {
    const role = parseClerkTestRole(roleValue);
    if (!role) {
      throw new Error(`Unknown Clerk test role: ${roleValue}`);
    }
    if (!roles.includes(role)) {
      roles.push(role);
    }
  }
  if (roles.length === 0) {
    throw new Error("At least one Clerk test role is required");
  }
  return roles;
}

function staleCutoff(value: string): Date {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error("Stale cleanup age must be a positive number of hours");
  }
  return new Date(Date.now() - hours * 60 * 60 * 1_000);
}

function parseDryRun(): boolean {
  const value = process.env.DRY_RUN;
  if (value === undefined || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error("DRY_RUN must be true or false");
}

function requiredArgument(index: number, name: string): string {
  const value = process.argv[index];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertNoExtraArguments(firstExtraArgument: number): void {
  if (process.argv[firstExtraArgument] !== undefined) {
    throw new Error(`Unexpected argument: ${process.argv[firstExtraArgument]}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
