import { MODEL_PROVIDER_FIREWALL_CONFIGS } from "@vm0/api-contracts/contracts/model-provider-firewalls";
import {
  RUNNER_RUNTIME_FIREWALL_CATALOG_DIGEST,
  RUNNER_RUNTIME_FIREWALL_CATALOG_VERSION,
  RUNNER_RUNTIME_FIREWALL_NAMES,
  hasRunnerRuntimeFirewall,
  loadAllRunnerRuntimeFirewalls,
  loadRunnerRuntimeFirewalls,
} from "@vm0/connectors/firewall-metadata/runner-runtime";
import {
  createRunnerRuntimeFirewallCatalog,
  projectRunnerRuntimeFirewall,
} from "@vm0/connectors/firewall-metadata/runner-runtime-catalog";
import type { Firewall } from "@vm0/connectors/firewall-types";

import { isExternalConnectorCatalogEnabled } from "../../lib/connector-catalog-source-selection";
import { singleton } from "../../lib/singleton";
import type { ReadonlyDb } from "../external/db";
import {
  loadAcceptedConnectorCatalogSnapshot,
  type AcceptedConnectorCatalogSnapshot,
  type ExternalCatalogIdentity,
} from "./connector-catalog-external-reader.service";
import { connectorCatalogFirewallConfig } from "./connector-catalog-artifacts/relationships";

const MODEL_PROVIDER_FIREWALL_PREFIX = "model-provider:";

interface ConnectorRunnerFirewallCatalog {
  readonly catalogDigest: string;
  readonly catalogVersion: string;
  readonly names: readonly string[];
  has(name: string): boolean;
  load(names: readonly string[] | undefined): Promise<Record<string, Firewall>>;
}

interface ExternalConnectorRunnerFirewallCatalog extends ConnectorRunnerFirewallCatalog {
  readonly acceptedIdentity: ExternalCatalogIdentity;
}

interface ExternalCatalogCache {
  catalog: ExternalConnectorRunnerFirewallCatalog | undefined;
  key: string | undefined;
}

type ReadonlyDbLoader = () => ReadonlyDb;

function externalIdentityKey(identity: ExternalCatalogIdentity): string {
  return [
    identity.sourceId,
    identity.schemaVersion,
    identity.catalogVersion,
    identity.catalogDigest,
    identity.capabilityDigest,
  ].join("\0");
}

const staticCatalog = singleton((): ConnectorRunnerFirewallCatalog => {
  return {
    catalogDigest: RUNNER_RUNTIME_FIREWALL_CATALOG_DIGEST,
    catalogVersion: RUNNER_RUNTIME_FIREWALL_CATALOG_VERSION,
    names: RUNNER_RUNTIME_FIREWALL_NAMES,
    has: hasRunnerRuntimeFirewall,
    load: async (names) => {
      return names === undefined
        ? await loadAllRunnerRuntimeFirewalls()
        : await loadRunnerRuntimeFirewalls(names);
    },
  };
});

const localModelProviderFirewalls = singleton((): readonly Firewall[] => {
  return Object.values(MODEL_PROVIDER_FIREWALL_CONFIGS).map((firewall) => {
    if (!firewall.name.startsWith(MODEL_PROVIDER_FIREWALL_PREFIX)) {
      throw new Error(
        `Local model-provider runner firewall has invalid ownership: ${firewall.name}`,
      );
    }
    return projectRunnerRuntimeFirewall(firewall);
  });
});

function createExternalCatalog(
  snapshot: AcceptedConnectorCatalogSnapshot,
): ExternalConnectorRunnerFirewallCatalog {
  const connectorFirewalls = snapshot.artifact.connectors.flatMap(
    (connector) => {
      const firewall = connectorCatalogFirewallConfig(connector);
      return firewall === null ? [] : [projectRunnerRuntimeFirewall(firewall)];
    },
  );
  const materialized = createRunnerRuntimeFirewallCatalog([
    ...connectorFirewalls,
    ...localModelProviderFirewalls(),
  ]);
  const nameSet = new Set(materialized.names);
  return {
    acceptedIdentity: snapshot.identity,
    catalogDigest: materialized.catalogDigest,
    catalogVersion: materialized.catalogVersion,
    names: materialized.names,
    has: (name) => {
      return nameSet.has(name);
    },
    load: (names) => {
      const selectedNames = names ?? materialized.names;
      return Promise.resolve(
        Object.fromEntries(
          selectedNames.map((name) => {
            const firewall = materialized.firewalls[name];
            if (!firewall) {
              throw new Error(`Missing runner runtime firewall: ${name}`);
            }
            return [name, firewall];
          }),
        ),
      );
    },
  };
}

const externalCatalogCache = singleton((): ExternalCatalogCache => {
  return { catalog: undefined, key: undefined };
});

async function loadExternalCatalog(
  db: ReadonlyDb,
): Promise<ExternalConnectorRunnerFirewallCatalog> {
  const snapshot = await loadAcceptedConnectorCatalogSnapshot(db);
  const key = externalIdentityKey(snapshot.identity);
  const cache = externalCatalogCache();
  if (cache.key === key && cache.catalog !== undefined) {
    return cache.catalog;
  }
  const catalog = createExternalCatalog(snapshot);
  cache.key = key;
  cache.catalog = catalog;
  return catalog;
}

async function loadExternalCatalogFromDb(
  loadDb: ReadonlyDbLoader,
): Promise<ExternalConnectorRunnerFirewallCatalog> {
  return await loadExternalCatalog(loadDb());
}

export async function loadConnectorRunnerFirewallCatalog(
  loadDb: ReadonlyDbLoader,
): Promise<ConnectorRunnerFirewallCatalog> {
  if (isExternalConnectorCatalogEnabled()) {
    return await loadExternalCatalogFromDb(loadDb);
  }
  return staticCatalog();
}
