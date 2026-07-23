import { isDeepStrictEqual } from "node:util";

import { normalizeConnectorFixedHost } from "@vm0/connectors/firewall-metadata/server";
import type {
  FirewallBaseHostPolicy,
  FirewallConfig,
} from "@vm0/connectors/firewall-types";

import type {
  ConnectorCatalogArtifact,
  ConnectorCatalogArtifactConnector,
  ConnectorCatalogAuthMethod,
} from "./artifacts";
import {
  firewallAuthInjectsCredentials,
  firewallBaseVariableNames,
  firewallTemplateReferences,
  parseFirewallBaseUrl,
  validateFirewallGeneratorResult,
} from "./firewall";
import {
  catalogSourceSchema,
  connectorSourceSchema,
  validateCatalogSourceSemantics,
  validateConnectorSourceSemantics,
  type ConnectorGrantSource,
} from "./source";

const MODEL_PROVIDER_FIREWALL_PREFIX = "model-provider:";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function sourceGrant(method: ConnectorCatalogAuthMethod): ConnectorGrantSource {
  switch (method.grant.kind) {
    case "manual": {
      return {
        kind: method.grant.kind,
        fields: method.grant.fields.map((field) => {
          return {
            privateName: field.privateName,
            publicId: field.publicId,
            label: field.label,
            required: field.required,
            ...(field.placeholder === null
              ? {}
              : { placeholder: field.placeholder }),
            storage: field.storage,
            ...(field.normalize === undefined
              ? {}
              : { normalize: field.normalize }),
          };
        }),
      };
    }
    case "device-auth": {
      return {
        kind: method.grant.kind,
        scopes: method.grant.scopes,
        outputs: method.grant.outputs,
        startOptions: method.grant.startOptions.map((option) => {
          return {
            privateName: option.privateName,
            publicId: option.publicId,
            kind: option.kind,
            label: option.label,
            required: option.required,
            ...(option.defaultValue === null
              ? {}
              : { defaultValue: option.defaultValue }),
            options: option.options,
          };
        }),
      };
    }
    case "auth-code":
    case "external-code":
    case "openid-auth": {
      return method.grant;
    }
  }
}

function validateConnectorSemantics(artifact: ConnectorCatalogArtifact): void {
  const catalogSource = catalogSourceSchema.parse({
    catalogVersion: artifact.catalogVersion,
    connectorRefs: artifact.connectors.map((connector) => {
      return connector.connectorRef;
    }),
    categoryMetadata: artifact.categoryMetadata,
  });
  validateCatalogSourceSemantics(catalogSource);

  const categoryIds = new Set(
    artifact.categoryMetadata.categories.map((category) => {
      return category.id;
    }),
  );
  const secretOwners = new Map<string, string>();
  const variableOwners = new Map<string, string>();

  for (const connector of artifact.connectors) {
    if (connector.connectorRef.startsWith(MODEL_PROVIDER_FIREWALL_PREFIX)) {
      throw new Error(
        `Connector catalog uses reserved ownership: ${connector.connectorRef}`,
      );
    }
    if (!categoryIds.has(connector.category)) {
      throw new Error(
        `Unknown category for connector ${connector.connectorRef}`,
      );
    }
    const source = connectorSourceSchema.parse({
      ref: connector.connectorRef,
      label: connector.label,
      description: connector.description,
      category: connector.category,
      generation: connector.generation,
      tags: connector.tags,
      authMethods: connector.authMethods.map((method) => {
        return {
          id: method.id,
          label: method.label,
          description: method.description,
          visible: method.visible,
          ...(method.featureSwitch === null
            ? {}
            : { featureSwitch: method.featureSwitch }),
          ...(method.client === undefined ? {} : { client: method.client }),
          storage: method.storage,
          grant: sourceGrant(method),
          access: method.access,
          revoke: method.revoke,
        };
      }),
    });
    validateConnectorSourceSemantics(source);

    for (const method of connector.authMethods) {
      for (const secretName of method.storage.secrets) {
        const owner = secretOwners.get(secretName);
        if (owner !== undefined && owner !== connector.connectorRef) {
          throw new Error(
            `Connector storage secret ${secretName} is claimed by ${owner} and ${connector.connectorRef}`,
          );
        }
        secretOwners.set(secretName, connector.connectorRef);
      }
      for (const variableName of method.storage.variables) {
        const owner = variableOwners.get(variableName);
        if (owner !== undefined && owner !== connector.connectorRef) {
          throw new Error(
            `Connector storage variable ${variableName} is claimed by ${owner} and ${connector.connectorRef}`,
          );
        }
        variableOwners.set(variableName, connector.connectorRef);
      }
    }
  }
}

export function connectorCatalogFirewallConfig(
  connector: ConnectorCatalogArtifactConnector,
): FirewallConfig | null {
  return connector.firewall.kind === "none"
    ? null
    : {
        name: connector.connectorRef,
        ...connector.firewall.config,
      };
}

function validateFirewallBindings(args: {
  readonly connector: ConnectorCatalogArtifactConnector;
  readonly firewall: FirewallConfig;
}): void {
  const knownEnvironmentNames = new Set<string>();
  for (const method of args.connector.authMethods) {
    for (const name of Object.keys(method.access.envBindings)) {
      knownEnvironmentNames.add(name);
    }
    for (const name of method.access.platformSecrets ?? []) {
      knownEnvironmentNames.add(name);
    }
  }
  const references = firewallTemplateReferences(args.firewall.apis);
  const unknown = [...references.secrets, ...references.vars].filter((name) => {
    return !knownEnvironmentNames.has(name);
  });
  if (unknown.length > 0) {
    throw new Error(
      `Firewall references unknown connector bindings: ${sortedUniqueStrings(unknown).join(", ")}`,
    );
  }
}

function validateBaseUrlTemplates(
  connectorRef: string,
  firewall: FirewallConfig,
): void {
  const templates = new Map<string, FirewallBaseHostPolicy | undefined>();
  for (const api of firewall.apis) {
    if (!api.base.includes("${{")) {
      continue;
    }
    parseFirewallBaseUrl(api.base);
    if (
      templates.has(api.base) &&
      !isDeepStrictEqual(templates.get(api.base), api.hostPolicy)
    ) {
      throw new Error(
        `Firewall base URL host policies conflict: ${connectorRef} (${api.base})`,
      );
    }
    templates.set(api.base, api.hostPolicy);
  }
}

export interface ConnectorCatalogFirewallBaseUrlTemplate {
  readonly base: string;
  readonly credentialed: boolean;
  readonly hostPolicy?: FirewallBaseHostPolicy;
}

export interface ConnectorCatalogFirewallRoutingApi {
  readonly base: string;
  readonly environmentNames: readonly string[];
  readonly routes: readonly {
    readonly permissionName: string;
    readonly rule: string;
  }[];
}

export interface ConnectorCatalogFirewallRouting {
  readonly fixedHosts: readonly string[];
  readonly baseUrlVarNames: readonly string[];
  readonly baseUrlTemplates: readonly ConnectorCatalogFirewallBaseUrlTemplate[];
  readonly apis: readonly ConnectorCatalogFirewallRoutingApi[];
}

export function deriveConnectorCatalogFirewallRouting(
  firewall: FirewallConfig,
): ConnectorCatalogFirewallRouting {
  return {
    fixedHosts: sortedUniqueStrings(
      firewall.apis.flatMap((api) => {
        const parsed = parseFirewallBaseUrl(api.base);
        return api.base.includes("${{") ? [] : [parsed.host];
      }),
    ),
    baseUrlVarNames: sortedUniqueStrings(
      firewall.apis.flatMap((api) => {
        return firewallBaseVariableNames(api.base);
      }),
    ),
    baseUrlTemplates: firewall.apis
      .filter((api) => {
        return api.base.includes("${{");
      })
      .map((api) => {
        return {
          base: api.base,
          credentialed: firewallAuthInjectsCredentials(api.auth),
          ...(api.hostPolicy === undefined
            ? {}
            : { hostPolicy: api.hostPolicy }),
        };
      })
      .sort((left, right) => {
        return compareStrings(left.base, right.base);
      }),
    apis: firewall.apis.map((api) => {
      const references = firewallTemplateReferences(api);
      return {
        base: api.base,
        environmentNames: sortedUniqueStrings([
          ...references.secrets,
          ...references.vars,
        ]),
        routes: (api.permissions ?? []).flatMap((permission) => {
          return permission.rules.map((rule) => {
            return { permissionName: permission.name, rule };
          });
        }),
      };
    }),
  };
}

export interface ConnectorCatalogFirewallDiagnostics {
  readonly apiCount: number;
  readonly permissionCount: number;
  readonly ruleCount: number;
}

export function deriveConnectorCatalogFirewallDiagnostics(
  firewall: FirewallConfig,
): ConnectorCatalogFirewallDiagnostics {
  const permissions = firewall.apis.flatMap((api) => {
    return api.permissions ?? [];
  });
  return {
    apiCount: firewall.apis.length,
    permissionCount: new Set(
      permissions.map((permission) => {
        return permission.name;
      }),
    ).size,
    ruleCount: permissions.reduce((count, permission) => {
      return count + permission.rules.length;
    }, 0),
  };
}

function validateFirewallSemantics(artifact: ConnectorCatalogArtifact): void {
  for (const connector of artifact.connectors) {
    if (connector.firewall.kind === "none") {
      continue;
    }
    const firewall = connectorCatalogFirewallConfig(connector);
    if (firewall === null) {
      throw new Error("Generated connector firewall is unavailable");
    }
    validateFirewallGeneratorResult({
      connectorRef: connector.connectorRef,
      firewall,
      categories: connector.firewall.categories,
      defaultAllowed: connector.firewall.defaultAllowed,
      defaultUnknownPolicy: connector.firewall.defaultUnknownPolicy,
    });
    validateFirewallBindings({ connector, firewall });
    validateBaseUrlTemplates(connector.connectorRef, firewall);

    const routing = deriveConnectorCatalogFirewallRouting(firewall);
    for (const rawHost of routing.fixedHosts) {
      const host = normalizeConnectorFixedHost(rawHost);
      if (!host) {
        throw new Error(
          `Firewall fixed host is invalid: ${connector.connectorRef}`,
        );
      }
    }
  }
}

export function validateConnectorCatalogArtifact(
  artifact: ConnectorCatalogArtifact,
): void {
  validateConnectorSemantics(artifact);
  validateFirewallSemantics(artifact);
}
