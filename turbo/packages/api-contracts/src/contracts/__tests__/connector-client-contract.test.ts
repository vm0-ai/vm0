import { describe, expect, it } from "vitest";

import {
  connectorExternalCodeSessionStartResponseSchema,
  connectorListResponseSchema,
  connectorOauthDeviceAuthSessionStartResponseSchema,
  connectorResponseSchema,
} from "../connector-schemas";
import { connectorsSlugCallbackContract } from "../connectors-slug-callback";
import { connectorChangedPayloadSchema } from "../realtime";
import {
  userConnectorEnabledSlugsSchema,
  userConnectorUpdateSchema,
} from "../user-connectors";
import { zeroConnectorCatalogContract } from "../zero-connector-catalog";
import {
  connectorCheckDiagnosticResultSchema,
  connectorCheckRequestSchema,
} from "../zero-connector-check";
import {
  zeroConnectorsBySlugContract,
  zeroConnectorsSearchContract,
} from "../zero-connectors";
import {
  applyUserPermissionGrantsRequestSchema,
  userPermissionGrantResponseSchema,
} from "../zero-user-permission-grants";
import { zeroWorkflowConnectorReadinessResponseSchema } from "../zero-workflows";
import { initClient } from "../trpc-contract";

const AGENT_ID = "00000000-0000-4000-a000-000000000001";

const connector = {
  id: "00000000-0000-4000-a000-000000000002",
  slug: "github",
  authMethod: "oauth",
  externalId: null,
  externalUsername: null,
  externalEmail: null,
  oauthScopes: null,
  connectionStatus: "connected",
  reconnectReason: null,
  tokenExpiresAt: null,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
} as const;

const catalogItem = {
  slug: "github",
  label: "GitHub",
  description: "GitHub connector",
  icon: {
    url: "https://example.test/github.svg",
    invertInDarkMode: false,
  },
  category: "development",
  generation: [],
  tags: [],
  authMethods: [],
  permissionSummary: {
    hasPermissions: false,
    permissionCount: 0,
    hasCategories: false,
    hasDefaultPolicyOverrides: false,
  },
} as const;

const connectorIdentity = {
  connectorSlug: "github",
  label: "GitHub",
  visibility: "available",
  credentialResolution: "network-boundary",
} as const;

describe("connector client response contracts", () => {
  it("parses canonical response payloads", () => {
    expect(connectorResponseSchema.parse(connector)).toStrictEqual(connector);
    expect(
      connectorListResponseSchema.parse({
        connectors: [connector],
        configuredConnectorSlugs: ["github"],
        connectorProvidedBindings: [
          {
            connectorSlug: "github",
            authMethod: "oauth",
            namespace: "secrets",
            name: "GITHUB_TOKEN",
            optional: false,
            source: { kind: "connector-secret", name: "accessToken" },
          },
        ],
      }),
    ).toMatchObject({ configuredConnectorSlugs: ["github"] });
    expect(
      connectorOauthDeviceAuthSessionStartResponseSchema.parse({
        sessionId: "00000000-0000-4000-a000-000000000003",
        sessionToken: "session-token",
        connectorSlug: "github",
        status: "pending",
        userCode: "ABCD-EFGH",
        verificationUri: "https://example.test/device",
        expiresIn: 600,
        interval: 5,
      }),
    ).toMatchObject({ connectorSlug: "github" });
    expect(
      connectorExternalCodeSessionStartResponseSchema.parse({
        sessionId: "00000000-0000-4000-a000-000000000004",
        sessionToken: "session-token",
        connectorSlug: "aws",
        status: "pending",
        authorizationUrl: "https://example.test/authorize",
        expiresIn: 600,
      }),
    ).toMatchObject({ connectorSlug: "aws" });
    expect(
      zeroConnectorsSearchContract.search.responses[200].parse({
        connectors: [
          {
            slug: "github",
            label: "GitHub",
            description: "GitHub connector",
            authMethods: ["oauth"],
          },
        ],
      }),
    ).toMatchObject({ connectors: [{ slug: "github" }] });
    expect(
      zeroConnectorCatalogContract.list.responses[200].parse({
        connectors: [catalogItem],
      }),
    ).toMatchObject({ connectors: [{ slug: "github" }] });
    expect(
      zeroConnectorCatalogContract.permissions.responses[200].parse({
        permissions: {
          connectorSlug: "github",
          label: "GitHub",
          icon: catalogItem.icon,
          permissionCount: 0,
          permissions: [],
          categories: null,
          defaultPolicy: {
            permissionDefault: "ask",
            unknownPolicy: "ask",
          },
        },
      }),
    ).toMatchObject({ permissions: { connectorSlug: "github" } });
    expect(
      connectorCheckDiagnosticResultSchema.parse({
        outcome: "resolved",
        mode: "url",
        connector: connectorIdentity,
        environmentNames: null,
        run: { status: "not-scoped" },
        method: "GET",
        base: "https://api.github.com",
        relativePath: "/user",
        permission: {
          kind: "unknown-endpoint",
          policy: { outcome: "allow", basis: "no-policy" },
        },
      }),
    ).toMatchObject({ connector: { connectorSlug: "github" } });
    expect(
      userConnectorEnabledSlugsSchema.parse({
        enabledConnectorSlugs: ["github"],
      }),
    ).toStrictEqual({ enabledConnectorSlugs: ["github"] });
    expect(
      userPermissionGrantResponseSchema.parse({
        agentId: AGENT_ID,
        connectorSlug: "github",
        permission: "contents:read",
        action: "allow",
        expiresAt: null,
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toMatchObject({ connectorSlug: "github" });
    expect(
      zeroWorkflowConnectorReadinessResponseSchema.parse({
        connectors: [
          {
            connectorSlug: "github",
            label: "GitHub",
            icon: catalogItem.icon,
            reason: "Connect GitHub",
            status: "not-connected",
          },
        ],
      }),
    ).toMatchObject({ connectors: [{ connectorSlug: "github" }] });
    expect(
      connectorChangedPayloadSchema.parse({ connectorSlug: "github" }),
    ).toStrictEqual({ connectorSlug: "github" });
  });
});

describe("connector client request contracts", () => {
  it("accepts canonical connector check requests", () => {
    const base = {
      mode: "url" as const,
      method: "GET",
      url: "https://api.github.com/user",
    };

    expect(
      connectorCheckRequestSchema.parse({
        ...base,
        connectorSlug: "github",
      }),
    ).toStrictEqual({ ...base, connectorSlug: "github" });
    expect(connectorCheckRequestSchema.parse(base)).toStrictEqual(base);
  });

  it("accepts canonical user connector updates", () => {
    expect(
      userConnectorUpdateSchema.parse({
        enabledConnectorSlugs: ["github"],
        operation: "add",
      }),
    ).toStrictEqual({
      enabledConnectorSlugs: ["github"],
      operation: "add",
    });
  });

  it("accepts canonical permission grants", () => {
    const base = {
      agentId: AGENT_ID,
      mode: "patch" as const,
      grants: [{ permission: "contents:read", action: "allow" as const }],
    };

    expect(
      applyUserPermissionGrantsRequestSchema.parse({
        ...base,
        connectorSlug: "github",
      }),
    ).toStrictEqual({ ...base, connectorSlug: "github" });
  });
});

describe("connector path parameter contracts", () => {
  it("keeps concrete connector URLs unchanged", async () => {
    const paths: string[] = [];
    const config = {
      baseUrl: "https://api.example.test",
      api: async (args: { readonly path: string }) => {
        paths.push(args.path);
        return {
          status: 204,
          body: undefined,
          headers: new Headers(),
        };
      },
    };

    await initClient(zeroConnectorsBySlugContract, config).delete({
      params: { connectorSlug: "github" },
      headers: {},
    });
    await initClient(zeroConnectorCatalogContract, config).permissions({
      params: { connectorSlug: "github" },
      headers: {},
    });
    await initClient(connectorsSlugCallbackContract, config).callback({
      params: { connectorSlug: "github" },
      query: { responseMode: "json" },
      headers: {},
    });

    expect(paths).toStrictEqual([
      "https://api.example.test/api/zero/connectors/github",
      "https://api.example.test/api/zero/connector-catalog/github/permissions",
      "https://api.example.test/api/connectors/github/callback?responseMode=json",
    ]);
  });
});
