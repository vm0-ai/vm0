import { describe, expect, it } from "vitest";

const SERVER_FIREWALL_METADATA_SPECIFIER =
  "@vm0/connectors/firewall-metadata/server";
const ROOT_FIREWALL_METADATA_SPECIFIER = "@vm0/connectors/firewall-metadata";
const CONNECTORS_SPECIFIER = "@vm0/connectors/connectors";
const IMPORT_SPECIFIER_PATTERN =
  /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const CONNECTORS_IMPORT_STATEMENT_PATTERN =
  /\bimport\s+(?!type\b)(?<clause>[^;]*?)\s+from\s*["']@vm0\/connectors\/connectors["']/g;

const PLATFORM_SRC_PREFIX = "../../";
const productionSourceModules = import.meta.glob<string>(
  "../../**/*.{ts,tsx}",
  {
    eager: true,
    query: "?raw",
    import: "default",
  },
);

function isProductionSourcePath(path: string): boolean {
  const segments = path.split("/");
  return !(
    segments.includes("__tests__") ||
    segments.includes("mocks") ||
    segments.includes("test") ||
    path.endsWith(".d.ts") ||
    path.includes(".test.") ||
    path.includes(".spec.") ||
    path.includes(".stories.")
  );
}

function sourcePathFromGlobKey(path: string): string {
  return path.startsWith(PLATFORM_SRC_PREFIX)
    ? path.slice(PLATFORM_SRC_PREFIX.length)
    : path;
}

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

function importsExactSpecifier(source: string, specifier: string): boolean {
  return importSpecifiers(source).some((importedSpecifier) => {
    return importedSpecifier === specifier;
  });
}

function importsConnectorTypesValue(source: string): boolean {
  return [...source.matchAll(CONNECTORS_IMPORT_STATEMENT_PATTERN)].some(
    (match) => {
      const namedImports =
        match.groups?.clause.match(/\{(?<imports>[\s\S]*?)\}/u)?.groups
          ?.imports ?? "";
      return namedImports.split(",").some((specifier) => {
        const trimmed = specifier.trim();
        if (trimmed.startsWith("type ")) {
          return false;
        }
        return trimmed.split(/\s+as\s+/u)[0]?.trim() === "CONNECTOR_TYPES";
      });
    },
  );
}

describe("firewall metadata import boundary", () => {
  it("keeps server-only firewall metadata out of platform production source", () => {
    const offenders = Object.entries(productionSourceModules)
      .map(([path, source]) => {
        return { path: sourcePathFromGlobKey(path), source };
      })
      .filter(({ path, source }) => {
        return (
          isProductionSourcePath(path) &&
          importsSpecifier(source, SERVER_FIREWALL_METADATA_SPECIFIER)
        );
      });

    expect(
      offenders.map((offender) => {
        return offender.path;
      }),
    ).toStrictEqual([]);
  });

  it("keeps generated firewall metadata root imports out of platform production source", () => {
    const offenders = Object.entries(productionSourceModules)
      .map(([path, source]) => {
        return { path: sourcePathFromGlobKey(path), source };
      })
      .filter(({ path, source }) => {
        return (
          isProductionSourcePath(path) &&
          importsExactSpecifier(source, ROOT_FIREWALL_METADATA_SPECIFIER)
        );
      });

    expect(
      offenders.map((offender) => {
        return offender.path;
      }),
    ).toStrictEqual([]);
  });

  it("keeps static connector category metadata out of platform production source", () => {
    const staticCategorySymbols = [
      "CONNECTOR_DISPLAY_CATEGORY_",
      "ConnectorDisplayCategory",
    ];
    const offenders = Object.entries(productionSourceModules)
      .map(([path, source]) => {
        return { path: sourcePathFromGlobKey(path), source };
      })
      .filter(({ path, source }) => {
        return (
          isProductionSourcePath(path) &&
          staticCategorySymbols.some((symbol) => {
            return source.includes(symbol);
          })
        );
      });

    expect(
      offenders.map((offender) => {
        return offender.path;
      }),
    ).toStrictEqual([]);
  });

  it("keeps static connector registry value imports out of platform production source", () => {
    const offenders = Object.entries(productionSourceModules)
      .map(([path, source]) => {
        return { path: sourcePathFromGlobKey(path), source };
      })
      .filter(({ path, source }) => {
        return (
          isProductionSourcePath(path) &&
          importsExactSpecifier(source, CONNECTORS_SPECIFIER) &&
          importsConnectorTypesValue(source)
        );
      });

    expect(
      offenders.map((offender) => {
        return offender.path;
      }),
    ).toStrictEqual([]);
  });
});
