import { isDeepStrictEqual } from "node:util";

import { normalizeConnectorFixedHost } from "@vm0/connectors/firewall-metadata/server";

import {
  type ConnectorCatalogIntegrityArtifact,
  type ConnectorCatalogPrivateArtifact,
  type ConnectorCatalogPrivateFirewallsArtifact,
  type ConnectorCatalogPublicArtifact,
  type ConnectorCatalogRunnerFirewallsArtifact,
  validateConnectorCatalogArtifacts,
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
  type ConnectorAuthMethodSource,
  type ConnectorGrantSource,
} from "./source";

function assertEqualValues(
  expected: readonly string[],
  actual: readonly string[],
  label: string,
): void {
  if (
    expected.length !== actual.length ||
    expected.some((value, index) => {
      return value !== actual[index];
    })
  ) {
    throw new Error(`${label} mismatch`);
  }
}

function reconstructedGrant(args: {
  readonly connectorRef: string;
  readonly publicMethod: ConnectorCatalogPublicArtifact["connectors"][number]["authMethods"][number];
  readonly privateMethod: ConnectorCatalogPrivateArtifact["connectors"][number]["authMethods"][number];
}): ConnectorGrantSource {
  const { connectorRef, publicMethod, privateMethod } = args;
  const label = `${connectorRef}/${privateMethod.id}`;
  if (privateMethod.grant.kind !== publicMethod.grantKind) {
    throw new Error(`${label} grant kind mismatch`);
  }
  switch (privateMethod.grant.kind) {
    case "manual": {
      if (publicMethod.startOptions.length > 0) {
        throw new Error(`${label} manual grant has start options`);
      }
      assertEqualValues(
        publicMethod.manualFields.map((field) => {
          return field.id;
        }),
        privateMethod.grant.fields.map((field) => {
          return field.publicId;
        }),
        `${label} manual fields`,
      );
      return {
        kind: "manual",
        fields: privateMethod.grant.fields.map((privateField, index) => {
          const publicField = publicMethod.manualFields[index];
          if (publicField === undefined) {
            throw new Error(`${label} missing public manual field`);
          }
          const expectedInputType =
            privateField.storage === "secret" ? "password" : "text";
          if (publicField.inputType !== expectedInputType) {
            throw new Error(`${label} manual field input type mismatch`);
          }
          return {
            privateName: privateField.privateName,
            publicId: privateField.publicId,
            label: publicField.label,
            required: publicField.required,
            ...(publicField.placeholder === null
              ? {}
              : { placeholder: publicField.placeholder }),
            storage: privateField.storage,
            ...(privateField.normalize === undefined
              ? {}
              : { normalize: privateField.normalize }),
          };
        }),
      };
    }
    case "device-auth": {
      if (publicMethod.manualFields.length > 0) {
        throw new Error(`${label} device grant has manual fields`);
      }
      assertEqualValues(
        publicMethod.startOptions.map((option) => {
          return option.id;
        }),
        privateMethod.grant.startOptionMappings.map((mapping) => {
          return mapping.publicId;
        }),
        `${label} start options`,
      );
      return {
        kind: "device-auth",
        scopes: privateMethod.grant.scopes,
        outputs: privateMethod.grant.outputs,
        startOptions: privateMethod.grant.startOptionMappings.map(
          (mapping, index) => {
            const publicOption = publicMethod.startOptions[index];
            if (publicOption === undefined) {
              throw new Error(`${label} missing public start option`);
            }
            return {
              privateName: mapping.privateName,
              publicId: mapping.publicId,
              kind: publicOption.kind,
              label: publicOption.label,
              required: publicOption.required,
              ...(publicOption.defaultValue === null
                ? {}
                : { defaultValue: publicOption.defaultValue }),
              options: publicOption.options,
            };
          },
        ),
      };
    }
    case "auth-code":
    case "openid-auth":
    case "external-code": {
      if (
        publicMethod.manualFields.length > 0 ||
        publicMethod.startOptions.length > 0
      ) {
        throw new Error(`${label} grant has unexpected public fields`);
      }
      return privateMethod.grant;
    }
  }
}

function reconstructedAuthMethod(args: {
  readonly connectorRef: string;
  readonly publicMethod: ConnectorCatalogPublicArtifact["connectors"][number]["authMethods"][number];
  readonly privateMethod: ConnectorCatalogPrivateArtifact["connectors"][number]["authMethods"][number];
}): ConnectorAuthMethodSource {
  return {
    id: args.privateMethod.id,
    label: args.publicMethod.label,
    description: args.publicMethod.description,
    visible: args.publicMethod.visible,
    ...(args.publicMethod.featureSwitch === null
      ? {}
      : { featureSwitch: args.publicMethod.featureSwitch }),
    ...(args.privateMethod.client === undefined
      ? {}
      : { client: args.privateMethod.client }),
    storage: args.privateMethod.storage,
    grant: reconstructedGrant(args),
    access: args.privateMethod.access,
    revoke: args.privateMethod.revoke,
  };
}

function validateCatalogAndConnectorSemantics(args: {
  readonly publicArtifact: ConnectorCatalogPublicArtifact;
  readonly privateArtifact: ConnectorCatalogPrivateArtifact;
}): void {
  const catalogSource = catalogSourceSchema.parse({
    catalogVersion: args.publicArtifact.catalogVersion,
    connectorRefs: args.publicArtifact.connectors.map((connector) => {
      return connector.connectorRef;
    }),
    categoryMetadata: args.publicArtifact.categoryMetadata,
  });
  validateCatalogSourceSemantics(catalogSource);
  const categoryIds = new Set(
    args.publicArtifact.categoryMetadata.categories.map((category) => {
      return category.id;
    }),
  );
  const privateByRef = new Map(
    args.privateArtifact.connectors.map((connector) => {
      return [connector.connectorRef, connector];
    }),
  );
  const secretOwners = new Map<string, string>();
  const variableOwners = new Map<string, string>();

  for (const publicConnector of args.publicArtifact.connectors) {
    if (!categoryIds.has(publicConnector.category)) {
      throw new Error(
        `Unknown category for connector ${publicConnector.connectorRef}`,
      );
    }
    const privateConnector = privateByRef.get(publicConnector.connectorRef);
    if (privateConnector === undefined) {
      throw new Error(
        `Missing private connector ${publicConnector.connectorRef}`,
      );
    }
    assertEqualValues(
      publicConnector.authMethods.map((method) => {
        return method.id;
      }),
      privateConnector.authMethods.map((method) => {
        return method.id;
      }),
      `${publicConnector.connectorRef} auth methods`,
    );
    const connectorSource = connectorSourceSchema.parse({
      ref: publicConnector.connectorRef,
      label: publicConnector.label,
      description: publicConnector.description,
      category: publicConnector.category,
      generation: publicConnector.generation,
      tags: publicConnector.tags,
      authMethods: privateConnector.authMethods.map((privateMethod, index) => {
        const publicMethod = publicConnector.authMethods[index];
        if (publicMethod === undefined) {
          throw new Error(
            `Missing public auth method ${publicConnector.connectorRef}/${privateMethod.id}`,
          );
        }
        return reconstructedAuthMethod({
          connectorRef: publicConnector.connectorRef,
          publicMethod,
          privateMethod,
        });
      }),
    });
    validateConnectorSourceSemantics(connectorSource);
    for (const method of privateConnector.authMethods) {
      for (const secretName of method.storage.secrets) {
        const owner = secretOwners.get(secretName);
        if (owner !== undefined && owner !== publicConnector.connectorRef) {
          throw new Error(
            `Connector storage secret ${secretName} is claimed by ${owner} and ${publicConnector.connectorRef}`,
          );
        }
        secretOwners.set(secretName, publicConnector.connectorRef);
      }
      for (const variableName of method.storage.variables) {
        const owner = variableOwners.get(variableName);
        if (owner !== undefined && owner !== publicConnector.connectorRef) {
          throw new Error(
            `Connector storage variable ${variableName} is claimed by ${owner} and ${publicConnector.connectorRef}`,
          );
        }
        variableOwners.set(variableName, publicConnector.connectorRef);
      }
    }
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function validateFirewallBindings(args: {
  readonly privateConnector: ConnectorCatalogPrivateArtifact["connectors"][number];
  readonly privateFirewall: ConnectorCatalogPrivateFirewallsArtifact["connectors"][number];
}): void {
  const knownEnvironmentNames = new Set<string>();
  for (const method of args.privateConnector.authMethods) {
    for (const name of Object.keys(method.access.envBindings)) {
      knownEnvironmentNames.add(name);
    }
    for (const name of method.access.platformSecrets ?? []) {
      knownEnvironmentNames.add(name);
    }
  }
  const references = firewallTemplateReferences(
    args.privateFirewall.firewall.apis,
  );
  const unknown = [...references.secrets, ...references.vars].filter((name) => {
    return !knownEnvironmentNames.has(name);
  });
  if (unknown.length > 0) {
    throw new Error(
      `Firewall references unknown connector bindings: ${sortedUniqueStrings(unknown).join(", ")}`,
    );
  }
  const unusedPlaceholders = Object.keys(
    args.privateFirewall.firewall.placeholders ?? {},
  ).filter((name) => {
    return !references.secrets.has(name);
  });
  if (unusedPlaceholders.length > 0) {
    throw new Error(
      `Firewall has unused placeholders: ${sortedUniqueStrings(unusedPlaceholders).join(", ")}`,
    );
  }
}

function expectedFirewallRouting(
  privateFirewall: ConnectorCatalogPrivateFirewallsArtifact["connectors"][number],
): ConnectorCatalogPrivateFirewallsArtifact["connectors"][number]["routing"] {
  const apis = privateFirewall.firewall.apis;
  return {
    fixedHosts: sortedUniqueStrings(
      apis.flatMap((api) => {
        const parsed = parseFirewallBaseUrl(api.base);
        return api.base.includes("${{") ? [] : [parsed.host];
      }),
    ),
    baseUrlVarNames: sortedUniqueStrings(
      apis.flatMap((api) => {
        return firewallBaseVariableNames(api.base);
      }),
    ),
    baseUrlTemplates: apis
      .filter((api) => {
        return api.base.includes("${{");
      })
      .map((api) => {
        parseFirewallBaseUrl(api.base);
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
    apis: apis.map((api) => {
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

function expectedFirewallDiagnostics(
  privateFirewall: ConnectorCatalogPrivateFirewallsArtifact["connectors"][number],
): ConnectorCatalogPrivateFirewallsArtifact["connectors"][number]["diagnostics"] {
  const permissions = privateFirewall.firewall.apis.flatMap((api) => {
    return api.permissions ?? [];
  });
  return {
    apiCount: privateFirewall.firewall.apis.length,
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

function validateFirewallProjection(args: {
  readonly publicConnector: ConnectorCatalogPublicArtifact["connectors"][number];
  readonly privateConnector: ConnectorCatalogPrivateArtifact["connectors"][number];
  readonly privateFirewall: ConnectorCatalogPrivateFirewallsArtifact["connectors"][number];
}): void {
  if (args.privateFirewall.label !== args.publicConnector.label) {
    throw new Error(
      `Firewall label mismatch: ${args.publicConnector.connectorRef}`,
    );
  }
  const baseUrlTemplates = new Map<
    string,
    (typeof args.privateFirewall.routing.baseUrlTemplates)[number]
  >();
  for (const template of args.privateFirewall.routing.baseUrlTemplates) {
    const existing = baseUrlTemplates.get(template.base);
    if (
      existing &&
      !isDeepStrictEqual(existing.hostPolicy, template.hostPolicy)
    ) {
      throw new Error(
        `Firewall base URL host policies conflict: ${args.publicConnector.connectorRef} (${template.base})`,
      );
    }
    baseUrlTemplates.set(template.base, template);
  }
  validateFirewallBindings(args);
  if (
    JSON.stringify(args.privateFirewall.routing) !==
      JSON.stringify(expectedFirewallRouting(args.privateFirewall)) ||
    JSON.stringify(args.privateFirewall.diagnostics) !==
      JSON.stringify(expectedFirewallDiagnostics(args.privateFirewall))
  ) {
    throw new Error(
      `Firewall derived metadata mismatch: ${args.publicConnector.connectorRef}`,
    );
  }
}

function validateFirewallSemantics(args: {
  readonly publicArtifact: ConnectorCatalogPublicArtifact;
  readonly privateArtifact: ConnectorCatalogPrivateArtifact;
  readonly privateFirewallsArtifact: ConnectorCatalogPrivateFirewallsArtifact;
}): void {
  const publicByRef = new Map(
    args.publicArtifact.connectors.map((connector) => {
      return [connector.connectorRef, connector];
    }),
  );
  const privateByRef = new Map(
    args.privateArtifact.connectors.map((connector) => {
      return [connector.connectorRef, connector];
    }),
  );
  const fixedHostOwners = new Map<string, string>();
  for (const connector of args.privateFirewallsArtifact.connectors) {
    validateFirewallGeneratorResult({
      connectorRef: connector.connectorRef,
      firewall: connector.firewall,
      categories: connector.categories,
      defaultAllowed: connector.defaultAllowed,
      defaultUnknownPolicy: connector.defaultUnknownPolicy,
    });
    const publicConnector = publicByRef.get(connector.connectorRef);
    const privateConnector = privateByRef.get(connector.connectorRef);
    if (publicConnector === undefined || privateConnector === undefined) {
      throw new Error(
        `Missing connector for firewall ${connector.connectorRef}`,
      );
    }
    validateFirewallProjection({
      publicConnector,
      privateConnector,
      privateFirewall: connector,
    });
    for (const rawHost of connector.routing.fixedHosts) {
      const host = normalizeConnectorFixedHost(rawHost);
      if (!host) {
        throw new Error(
          `Firewall fixed host is invalid: ${connector.connectorRef}`,
        );
      }
      const existingOwner = fixedHostOwners.get(host);
      if (
        existingOwner !== undefined &&
        existingOwner !== connector.connectorRef
      ) {
        throw new Error(
          `Firewall fixed host collision: ${host} (${existingOwner}, ${connector.connectorRef})`,
        );
      }
      fixedHostOwners.set(host, connector.connectorRef);
    }
  }
}

export function validateConnectorCatalogRelationships(args: {
  readonly publicArtifact: ConnectorCatalogPublicArtifact;
  readonly privateArtifact: ConnectorCatalogPrivateArtifact;
  readonly privateFirewallsArtifact: ConnectorCatalogPrivateFirewallsArtifact;
  readonly runnerFirewallsArtifact: ConnectorCatalogRunnerFirewallsArtifact;
  readonly integrity: ConnectorCatalogIntegrityArtifact;
}): void {
  validateConnectorCatalogArtifacts(args);
  validateCatalogAndConnectorSemantics(args);
  validateFirewallSemantics(args);
}
