import { createHash } from "node:crypto";

import {
  type ConnectorCatalogArtifact,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
} from "../connector-catalog/artifacts/artifacts";
import {
  decodeConnectorCatalogSnapshot,
  encodeConnectorCatalogSnapshot,
} from "../connector-catalog/artifacts/loader";

const CONNECTOR_SLUG = "token-security";
const CATALOG_VERSION = "2026-09-03.exact-public-slug";
const STORAGE_NAME = `connector-skill@${CONNECTOR_SLUG}`;
const VERSION_ID = "a".repeat(64);
const STORAGE_VERSION_PREFIX = `__system__/volume/${STORAGE_NAME}/${VERSION_ID}`;
const PRIVATE_NAME = "TOKEN_SECURITY_API_TOKEN";
const VALUE_REF = `$secrets.${PRIVATE_NAME}`;

function catalogArtifact(description: string): ConnectorCatalogArtifact {
  return {
    artifactSchemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    categoryMetadata: {
      categories: [
        {
          id: "testing",
          label: "Testing",
          menuLabel: "Testing",
          groupId: null,
        },
      ],
      groups: [],
    },
    connectors: [
      {
        slug: CONNECTOR_SLUG,
        label: "Token Security",
        description,
        category: "testing",
        generation: [],
        tags: ["fixture"],
        authMethods: [
          {
            id: "api-token",
            label: "API Token",
            description: null,
            visible: true,
            storage: {
              version: 1,
              secrets: [PRIVATE_NAME],
              variables: [],
            },
            grant: {
              kind: "manual",
              fields: [
                {
                  privateName: PRIVATE_NAME,
                  publicId: "credential",
                  label: "API token",
                  required: true,
                  placeholder: null,
                  storage: "secret",
                },
              ],
            },
            access: {
              kind: "static",
              envBindings: { SERVICE_TOKEN: VALUE_REF },
            },
            revoke: { kind: "none" },
          },
        ],
        icon: {
          key: "connectors/token-security.svg",
          invertInDarkMode: false,
        },
        skill: {
          kind: "bundled",
          storageName: STORAGE_NAME,
          versionId: VERSION_ID,
          storageVersionPrefix: STORAGE_VERSION_PREFIX,
          size: 128,
          archiveSize: 256,
          fileCount: 1,
        },
        firewall: { kind: "none" },
      },
    ],
  };
}

function decodeCatalog(description: string): ConnectorCatalogArtifact {
  const rawBytes = Buffer.from(
    `${JSON.stringify(catalogArtifact(description))}\n`,
  );
  return decodeConnectorCatalogSnapshot({
    catalogGzip: encodeConnectorCatalogSnapshot(rawBytes),
    catalogRawSize: rawBytes.byteLength,
    catalogVersion: CATALOG_VERSION,
    catalogDigest: `sha256:${createHash("sha256").update(rawBytes).digest("hex")}`,
  }).artifact;
}

describe("connector catalog public projection", () => {
  it("accepts the exact public slug derived from bundled skill storage", () => {
    const artifact = decodeCatalog("Public connector description");

    expect(artifact.connectors[0]?.slug).toBe(CONNECTOR_SLUG);
  });

  it.each([
    ["full bundled skill storage name", STORAGE_NAME],
    ["bundled skill version ID", VERSION_ID],
    ["full bundled skill storage version prefix", STORAGE_VERSION_PREFIX],
    ["private storage name", PRIVATE_NAME],
    ["private value reference", VALUE_REF],
  ])("rejects a leaked %s", (_name, privateValue) => {
    expect(() => {
      decodeCatalog(privateValue);
    }).toThrow("public-leakage");
  });
});
