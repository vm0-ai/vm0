import { createHash } from "node:crypto";

import {
  type ConnectorCatalogIntegrityArtifact,
  type ConnectorCatalogPrivateArtifact,
  type ConnectorCatalogPrivateFirewallsArtifact,
  type ConnectorCatalogPublicArtifact,
  type ConnectorCatalogRunnerFirewallsArtifact,
  type StaticFilesPublicationManifest,
  validateConnectorCatalogArtifacts,
} from "./artifacts";
import { validateFirewallGeneratorResult } from "./firewall";
import {
  catalogSourceSchema,
  connectorSourceSchema,
  validateCatalogSourceSemantics,
  validateConnectorSourceSemantics,
  type ConnectorAuthMethodSource,
  type ConnectorGrantSource,
} from "./source";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      return canonicalJsonValue(item);
    });
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => {
        return [key, canonicalJsonValue(value[key])];
      }),
  );
}

function canonicalDigest(value: unknown): string {
  const bytes = Buffer.from(
    `${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`,
  );
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

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
    defaultVisible: args.publicMethod.defaultVisible,
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
  }
}

function validateFirewallSemantics(
  privateFirewallsArtifact: ConnectorCatalogPrivateFirewallsArtifact,
): void {
  for (const connector of privateFirewallsArtifact.connectors) {
    validateFirewallGeneratorResult({
      connectorRef: connector.connectorRef,
      firewall: connector.firewall,
      categories: connector.categories,
      defaultAllowed: connector.defaultAllowed,
      defaultUnknownPolicy: connector.defaultUnknownPolicy,
    });
  }
}

function validateSliceDigests(args: {
  readonly publicArtifact: ConnectorCatalogPublicArtifact;
  readonly privateArtifact: ConnectorCatalogPrivateArtifact;
  readonly privateFirewallsArtifact: ConnectorCatalogPrivateFirewallsArtifact;
  readonly runnerFirewallsArtifact: ConnectorCatalogRunnerFirewallsArtifact;
  readonly integrity: ConnectorCatalogIntegrityArtifact;
}): void {
  const privateByRef = new Map(
    args.privateArtifact.connectors.map((connector) => {
      return [connector.connectorRef, connector];
    }),
  );
  const privateFirewallByRef = new Map(
    args.privateFirewallsArtifact.connectors.map((connector) => {
      return [connector.connectorRef, connector];
    }),
  );
  const runnerByRef = new Map(
    args.runnerFirewallsArtifact.firewalls.map((firewall) => {
      return [firewall.name, firewall];
    }),
  );
  const integrityByRef = new Map(
    args.integrity.connectors.map((connector) => {
      return [connector.connectorRef, connector];
    }),
  );

  for (const publicConnector of args.publicArtifact.connectors) {
    const connectorRef = publicConnector.connectorRef;
    const privateConnector = privateByRef.get(connectorRef);
    const integrityConnector = integrityByRef.get(connectorRef);
    if (privateConnector === undefined || integrityConnector === undefined) {
      throw new Error(`Missing integrity slice for ${connectorRef}`);
    }
    if (
      integrityConnector.publicDigest !== canonicalDigest(publicConnector) ||
      integrityConnector.privateDigest !== canonicalDigest(privateConnector)
    ) {
      throw new Error(`Catalog slice digest mismatch for ${connectorRef}`);
    }
    const privateFirewall = privateFirewallByRef.get(connectorRef);
    const runnerFirewall = runnerByRef.get(connectorRef);
    const privateFirewallDigest =
      privateFirewall === undefined ? null : canonicalDigest(privateFirewall);
    const runnerFirewallDigest =
      runnerFirewall === undefined ? null : canonicalDigest(runnerFirewall);
    if (
      integrityConnector.privateFirewallDigest !== privateFirewallDigest ||
      integrityConnector.runnerFirewallDigest !== runnerFirewallDigest
    ) {
      throw new Error(`Firewall slice digest mismatch for ${connectorRef}`);
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
  const staticFilesPublicationArtifact: StaticFilesPublicationManifest = {
    artifactSchemaVersion: 1,
    files: args.integrity.assets.map((asset) => {
      return { ...asset };
    }),
  };
  validateConnectorCatalogArtifacts({
    ...args,
    staticFilesPublicationArtifact,
  });
  validateCatalogAndConnectorSemantics(args);
  validateFirewallSemantics(args.privateFirewallsArtifact);
  validateSliceDigests(args);
}
