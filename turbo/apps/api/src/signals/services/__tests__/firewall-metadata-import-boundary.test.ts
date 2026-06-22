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
const RUN_CREATION_SERVICE = "agent-run-create.service.ts";
const IMPORT_SPECIFIER_PATTERN =
  /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function importSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].map((match) => {
    return match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
  });
}

function importsSpecifier(source: string, specifier: string): boolean {
  return importSpecifiers(source).some((importedSpecifier) => {
    return (
      importedSpecifier === specifier ||
      importedSpecifier.startsWith(`${specifier}/`)
    );
  });
}

function importsEagerConnectorRuntimeFirewall(source: string): boolean {
  return importSpecifiers(source).some((specifier) => {
    if (specifier === "@vm0/connectors/firewalls") {
      return true;
    }
    if (specifier === "@vm0/connectors/firewalls/runtime") {
      return false;
    }
    return specifier.startsWith("@vm0/connectors/firewalls/");
  });
}

describe("firewall metadata import boundary", () => {
  it("matches forbidden runtime firewall import forms", () => {
    for (const source of [
      `import { getConnectorFirewall } from "@vm0/connectors/firewalls";`,
      `import type { FirewallConnectorType } from "@vm0/connectors/firewalls";`,
      `export { getConnectorFirewall } from "@vm0/connectors/firewalls";`,
      `await import("@vm0/connectors/firewalls/github.generated");`,
      `import "@vm0/connectors/firewalls";`,
      `require("@vm0/connectors/firewalls/github.generated");`,
    ]) {
      expect(
        importsSpecifier(source, "@vm0/connectors/firewalls"),
      ).toBeTruthy();
    }

    expect(
      importsSpecifier(
        `import { loadFirewallPermissionIndex } from "@vm0/connectors/firewall-metadata/server";`,
        "@vm0/connectors/firewalls",
      ),
    ).toBeFalsy();
  });

  it.each(METADATA_ONLY_SERVICES)(
    "%s does not import runtime firewall catalogs",
    (service) => {
      const source = readFileSync(resolve(SERVICE_DIR, service), "utf8");

      for (const specifier of FORBIDDEN_RUNTIME_FIREWALL_IMPORTS) {
        expect(importsSpecifier(source, specifier)).toBeFalsy();
      }
    },
  );

  it("keeps run creation off eager runtime firewall catalogs", () => {
    const source = readFileSync(
      resolve(SERVICE_DIR, RUN_CREATION_SERVICE),
      "utf8",
    );

    expect(importsEagerConnectorRuntimeFirewall(source)).toBeFalsy();
    expect(importsSpecifier(source, "@vm0/core/firewalls")).toBeFalsy();
    expect(
      importsSpecifier(
        source,
        "@vm0/connectors/firewall-execution-metadata/server",
      ),
    ).toBeFalsy();
  });
});
