/**
 * ESLint rule: no-duplicate-migration-prefix
 *
 * Detects duplicate numeric prefixes in database migration files.
 * Migration files follow the pattern: {4-digit}_{name}.sql
 *
 * This rule scans the migrations directory once per lint process
 * (using module-level caching) and reports any duplicate prefixes.
 *
 * Good:
 *   0065_add_variables.sql
 *   0066_add_permissions.sql
 *
 * Bad:
 *   0065_add_variables.sql
 *   0065_add_permissions.sql  // Duplicate prefix!
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRule } from "../utils.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Module-level cache to ensure we only check and report once per ESLint process
let hasChecked = false;
let hasReported = false;
let cachedError: { prefix: string; files: string[] }[] | null = null;

const MIGRATION_PREFIX_PATTERN = /^(\d{4})_.*\.sql$/;

export function findDuplicatePrefixes(
  migrationsDir: string,
): { prefix: string; files: string[] }[] {
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }

  const files = fs.readdirSync(migrationsDir);
  const prefixMap = new Map<string, string[]>();

  for (const file of files) {
    const match = MIGRATION_PREFIX_PATTERN.exec(file);
    if (match && match[1]) {
      const prefix = match[1];
      const existing = prefixMap.get(prefix) ?? [];
      existing.push(file);
      prefixMap.set(prefix, existing);
    }
  }

  const duplicates: { prefix: string; files: string[] }[] = [];
  for (const [prefix, fileList] of prefixMap) {
    if (fileList.length > 1) {
      duplicates.push({ prefix, files: fileList.sort() });
    }
  }

  return duplicates;
}

export default createRule({
  name: "no-duplicate-migration-prefix",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow duplicate numeric prefixes in database migration files.",
      recommended: true,
    },
    schema: [],
    messages: {
      duplicatePrefix:
        'Duplicate migration prefix "{{prefix}}" found in: {{files}}. Each migration must have a unique numeric prefix.',
    },
  },
  create(context) {
    return {
      Program(node) {
        // Only check and report once per ESLint process
        if (hasReported) {
          return;
        }

        if (!hasChecked) {
          hasChecked = true;

          // Resolve migrations directory relative to this rule file
          const migrationsDir = path.resolve(
            __dirname,
            "../../src/db/migrations",
          );

          const duplicates = findDuplicatePrefixes(migrationsDir);
          if (duplicates.length > 0) {
            cachedError = duplicates;
          }
        }

        // Report errors only once
        if (cachedError) {
          hasReported = true;
          for (const dup of cachedError) {
            context.report({
              node,
              messageId: "duplicatePrefix",
              data: {
                prefix: dup.prefix,
                files: dup.files.join(", "),
              },
            });
          }
        }
      },
    };
  },
});
