import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONNECTOR_CATALOG_ACTIVE_KEY,
  loadConnectorCatalogArtifacts,
  type ConnectorCatalogArtifactReader,
  type ValidatedConnectorCatalogArtifacts,
} from "./loader";

const CONNECTOR_CATALOG_FIXTURE_ACTIVE_KEY =
  DEFAULT_CONNECTOR_CATALOG_ACTIVE_KEY;
export const CONNECTOR_CATALOG_FIXTURE_KEYS = [
  "active.json",
  "manifest.json",
  "public/catalog.json",
  "private/runtime.json",
] as const;

const CONNECTOR_CATALOG_FIXTURE_ROOT = fileURLToPath(
  new URL("./__fixtures__/catalog-v1/", import.meta.url),
);

function fixtureArtifactPath(root: string, key: string): string {
  const rootPath = resolve(root);
  const path = resolve(rootPath, key);
  if (path !== rootPath && !path.startsWith(`${rootPath}${sep}`)) {
    throw new Error(
      `Connector catalog fixture key escapes fixture root: ${key}`,
    );
  }
  return path;
}

export function createFixtureConnectorCatalogArtifactReader(
  root = CONNECTOR_CATALOG_FIXTURE_ROOT,
): ConnectorCatalogArtifactReader {
  return {
    async readArtifact(key: string): Promise<Uint8Array> {
      return await readFile(fixtureArtifactPath(root, key));
    },
  };
}

export function loadFixtureConnectorCatalogArtifacts(): Promise<ValidatedConnectorCatalogArtifacts> {
  return loadConnectorCatalogArtifacts({
    reader: createFixtureConnectorCatalogArtifactReader(),
    activeKey: CONNECTOR_CATALOG_FIXTURE_ACTIVE_KEY,
  });
}
