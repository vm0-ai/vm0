/// <reference types="node" />

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const API_SOURCE_DIR = path.resolve(import.meta.dirname, "..");
const CONNECTORS_SOURCE_DIR = path.resolve(
  import.meta.dirname,
  "../../../../packages/connectors/src",
);
const AUTH_PROVIDERS_SOURCE_DIR = path.join(
  CONNECTORS_SOURCE_DIR,
  "auth-providers",
);
const STATIC_CONNECTORS_SOURCE_DIR = path.join(
  CONNECTORS_SOURCE_DIR,
  "connectors",
);
const STATIC_CONNECTOR_UTILS_PATH = path.join(
  CONNECTORS_SOURCE_DIR,
  "connector-utils",
);

function isStaticConnectorPackageImport(specifier: string): boolean {
  return (
    specifier === "@vm0/connectors" ||
    specifier === "@vm0/connectors/connectors" ||
    specifier.startsWith("@vm0/connectors/connectors/") ||
    specifier === "@vm0/connectors/connector-utils"
  );
}

function isAllowedApiStaticImport(
  relativePath: string,
  specifier: string,
): boolean {
  switch (relativePath) {
    case "signals/services/agent-run-create.service.ts":
    case "test-fixtures/x-connector.ts": {
      return specifier === "@vm0/connectors/connectors";
    }
    case "signals/services/connector-catalog-form-fields.service.ts":
    case "signals/services/connector-catalog-reader.service.ts":
    case "signals/services/connector-catalog-runtime.service.ts": {
      return (
        specifier === "@vm0/connectors/connectors" ||
        specifier === "@vm0/connectors/connector-utils"
      );
    }
    default: {
      return false;
    }
  }
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

function moduleSpecifiers(filePath: string): string[] {
  return ts
    .preProcessFile(fs.readFileSync(filePath, "utf8"), true, true)
    .importedFiles.map((importedFile) => {
      return importedFile.fileName;
    });
}

function resolvesToStaticConnectorSource(
  filePath: string,
  specifier: string,
): boolean {
  if (!specifier.startsWith(".")) {
    return isStaticConnectorPackageImport(specifier);
  }
  const resolved = path.resolve(path.dirname(filePath), specifier);
  return (
    resolved === STATIC_CONNECTORS_SOURCE_DIR ||
    resolved.startsWith(`${STATIC_CONNECTORS_SOURCE_DIR}${path.sep}`) ||
    resolved === STATIC_CONNECTOR_UTILS_PATH ||
    resolved === `${STATIC_CONNECTOR_UTILS_PATH}.ts`
  );
}

describe("connector execution import boundary", () => {
  it("keeps provider production code independent from static connector sources", () => {
    const violations = sourceFiles(AUTH_PROVIDERS_SOURCE_DIR).flatMap(
      (filePath) => {
        return moduleSpecifiers(filePath)
          .filter((specifier) => {
            return resolvesToStaticConnectorSource(filePath, specifier);
          })
          .map((specifier) => {
            return `${path.relative(AUTH_PROVIDERS_SOURCE_DIR, filePath)} -> ${specifier}`;
          });
      },
    );

    expect(violations).toStrictEqual([]);
  });

  it("limits API static imports to the retained catalog fallbacks", () => {
    const violations = sourceFiles(API_SOURCE_DIR).flatMap((filePath) => {
      const relativePath = path.relative(API_SOURCE_DIR, filePath);
      return moduleSpecifiers(filePath)
        .filter((specifier) => {
          return (
            isStaticConnectorPackageImport(specifier) &&
            !isAllowedApiStaticImport(relativePath, specifier)
          );
        })
        .map((specifier) => {
          return `${relativePath} -> ${specifier}`;
        });
    });

    expect(violations).toStrictEqual([]);
  });
});
