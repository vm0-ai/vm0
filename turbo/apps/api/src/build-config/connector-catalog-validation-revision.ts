import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ConnectorCatalogValidationRevisionMember {
  readonly path: string;
  readonly content: string | Uint8Array;
}

const VALIDATION_SURFACE_PATHS = [
  "apps/api/src/build-config/connector-catalog-validation-revision.ts",
  "apps/api/src/lib/env.ts",
  "apps/api/src/signals/services/connector-catalog-artifacts",
  "apps/api/src/signals/services/connector-catalog-compatibility.service.ts",
  "apps/api/src/signals/services/connector-catalog-runtime-projection.service.ts",
  "apps/api/src/signals/services/connector-catalog-source.ts",
  "apps/api/src/signals/services/connector-catalog-validator-authority.ts",
  "apps/api/src/signals/utils.ts",
  "packages/api-contracts/src/contracts",
  "packages/connectors/src",
  "packages/core/src/public-brand.ts",
  "packages/core/src/storage-names.ts",
  "packages/db/src/jsonb-contracts/connector-catalog.ts",
  "packages/db/src/schema/connector-catalog.ts",
  "pnpm-lock.yaml",
] as const;

function isProductionSource(relativePath: string): boolean {
  return (
    !relativePath.split("/").includes("__tests__") &&
    !/\.(?:bench|spec|test)\.[cm]?[jt]sx?$/u.test(relativePath) &&
    /\.(?:json|[cm]?[jt]sx?)$/u.test(relativePath)
  );
}

function normalizedRelativePath(root: string, memberPath: string): string {
  return path.relative(root, memberPath).split(path.sep).join("/");
}

function collectDirectoryMembers(
  root: string,
  directory: string,
): ConnectorCatalogValidationRevisionMember[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(
    (entry: Dirent) => {
      const memberPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectDirectoryMembers(root, memberPath);
      }
      const relativePath = normalizedRelativePath(root, memberPath);
      return entry.isFile() && isProductionSource(relativePath)
        ? [{ path: relativePath, content: readFileSync(memberPath) }]
        : [];
    },
  );
}

function collectPathMembers(
  root: string,
  relativePath: string,
): ConnectorCatalogValidationRevisionMember[] {
  const memberPath = path.join(root, relativePath);
  return statSync(memberPath).isDirectory()
    ? collectDirectoryMembers(root, memberPath)
    : [{ path: relativePath, content: readFileSync(memberPath) }];
}

export function connectorCatalogValidationRevisionFromMembers(
  members: readonly ConnectorCatalogValidationRevisionMember[],
): string {
  const hash = createHash("sha256");
  for (const member of [...members].sort((left, right) => {
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  })) {
    const content =
      typeof member.content === "string"
        ? Buffer.from(member.content, "utf8")
        : member.content;
    hash.update(member.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(content.byteLength), "utf8");
    hash.update("\0", "utf8");
    hash.update(content);
    hash.update("\0", "utf8");
  }
  // The existing authority column is 40 hex characters. Truncating SHA-256
  // keeps 160 bits of collision resistance without a rollout migration.
  return hash.digest("hex").slice(0, 40);
}

function packageVersionMember(args: {
  readonly packageName: string;
  readonly packageJsonPath: string;
  readonly workspacePath: string;
}): ConnectorCatalogValidationRevisionMember {
  const packageJson = JSON.parse(
    readFileSync(args.packageJsonPath, "utf8"),
  ) as unknown;
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    !("version" in packageJson) ||
    typeof packageJson.version !== "string"
  ) {
    throw new Error(`Package ${args.packageName} has no string version`);
  }
  return {
    path: `external/${args.workspacePath}/${args.packageName}/version`,
    content: packageJson.version,
  };
}

export function connectorCatalogValidationRevision(): string {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const members = VALIDATION_SURFACE_PATHS.flatMap((relativePath) => {
    return collectPathMembers(root, relativePath);
  });
  members.push(
    packageVersionMember({
      packageName: "zod",
      workspacePath: "apps/api",
      packageJsonPath: path.join(
        root,
        "apps/api/node_modules/zod/package.json",
      ),
    }),
    packageVersionMember({
      packageName: "zod",
      workspacePath: "packages/api-contracts",
      packageJsonPath: path.join(
        root,
        "packages/api-contracts/node_modules/zod/package.json",
      ),
    }),
    packageVersionMember({
      packageName: "zod",
      workspacePath: "packages/connectors",
      packageJsonPath: path.join(
        root,
        "packages/connectors/node_modules/zod/package.json",
      ),
    }),
    packageVersionMember({
      packageName: "tr46",
      workspacePath: "packages/connectors",
      packageJsonPath: path.join(
        root,
        "packages/connectors/node_modules/tr46/package.json",
      ),
    }),
  );
  return connectorCatalogValidationRevisionFromMembers(members);
}
