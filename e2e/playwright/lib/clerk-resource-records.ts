import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { ClerkTestOwner } from "./clerk-api";

export interface ClerkResourceRecord {
  readonly kind: "user" | "organization" | "pending-organization";
  readonly id: string;
  readonly owner: ClerkTestOwner;
}

export async function recordClerkResource(
  resource: ClerkResourceRecord,
): Promise<void> {
  const directory = process.env.E2E_CLERK_RESOURCE_DIR;
  if (!directory) {
    return;
  }
  await mkdir(directory, { recursive: true });
  const destination = resourcePath(directory, resource.kind, resource.id);
  const temporary = destination + ".tmp-" + randomUUID();
  await writeFile(temporary, JSON.stringify(resource) + "\n", { mode: 0o600 });
  await rename(temporary, destination);
}

export async function forgetClerkResource(
  kind: ClerkResourceRecord["kind"],
  id: string,
): Promise<void> {
  const directory = process.env.E2E_CLERK_RESOURCE_DIR;
  if (directory) {
    await rm(resourcePath(directory, kind, id), { force: true });
  }
}

export async function readClerkResourceRecords(): Promise<readonly unknown[]> {
  const directory = process.env.E2E_CLERK_RESOURCE_DIR;
  if (!directory) {
    throw new Error("E2E_CLERK_RESOURCE_DIR is required for recorded cleanup");
  }
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return [];
    }
    throw cause;
  }
  const records: unknown[] = [];
  for (const name of names.sort()) {
    if (name.endsWith(".json")) {
      records.push(JSON.parse(await readFile(join(directory, name), "utf8")));
    }
  }
  return records;
}

function resourcePath(
  directory: string,
  kind: ClerkResourceRecord["kind"],
  id: string,
): string {
  if (!/^(?:user|org)_[a-zA-Z0-9_]+$/.test(id)) {
    throw new Error("Invalid Clerk resource ID");
  }
  return join(directory, kind + "-" + id + ".json");
}
