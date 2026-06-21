import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SERVICE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const METADATA_ONLY_SERVICES = [
  "cron-aggregate-insights.service.ts",
  "zero-custom-connector.service.ts",
  "zero-user-permission-grants.service.ts",
  "zero-runs-create.service.ts",
] as const;
const FORBIDDEN_RUNTIME_FIREWALL_IMPORTS = [
  "@vm0/connectors/firewalls",
  "@vm0/core/firewalls",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function importPattern(specifier: string): RegExp {
  const escapedSpecifier = escapeRegExp(specifier);
  return new RegExp(
    `(?:from\\s+["']${escapedSpecifier}["']|import\\s*\\(\\s*["']${escapedSpecifier}["']\\s*\\))`,
  );
}

describe("firewall metadata import boundary", () => {
  it.each(METADATA_ONLY_SERVICES)(
    "%s does not import runtime firewall catalogs",
    (service) => {
      const source = readFileSync(resolve(SERVICE_DIR, service), "utf8");

      for (const specifier of FORBIDDEN_RUNTIME_FIREWALL_IMPORTS) {
        expect(source).not.toMatch(importPattern(specifier));
      }
    },
  );
});
