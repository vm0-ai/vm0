import {
  cleanupClerkTestJobRef,
  cleanupCurrentClerkTestGeneration,
  cleanupStaleClerkTestResources,
  currentClerkTestJobRef,
  parseClerkTestRole,
  type ClerkCleanupResult,
  type ClerkTestRole,
} from "./lib/clerk-api";

const STALE_CLEANUP_ARGUMENT = "--older-than-hours";

async function main(): Promise<void> {
  const command = process.argv[2];
  const dryRun = parseDryRun();
  let result: ClerkCleanupResult;

  switch (command) {
    case "cleanup-generation":
      result = await cleanupCurrentClerkTestGeneration(
        parseRoles(requiredArgument(3, "role list")),
        { dryRun },
      );
      break;
    case "cleanup-job-ref":
      assertNoExtraArguments(3);
      result = await cleanupClerkTestJobRef(currentClerkTestJobRef(), {
        dryRun,
      });
      break;
    case "cleanup-stale":
      if (process.argv[3] !== STALE_CLEANUP_ARGUMENT) {
        throw new Error(
          `cleanup-stale requires ${STALE_CLEANUP_ARGUMENT} <hours>`,
        );
      }
      result = await cleanupStaleClerkTestResources(
        staleCutoff(requiredArgument(4, "stale age")),
        { dryRun },
      );
      assertNoExtraArguments(5);
      break;
    default:
      throw new Error(
        "Usage: clerk-test-resources.ts cleanup-generation <roles> | cleanup-job-ref | cleanup-stale --older-than-hours <hours>",
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
  assertNoExtraArguments(4);
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
