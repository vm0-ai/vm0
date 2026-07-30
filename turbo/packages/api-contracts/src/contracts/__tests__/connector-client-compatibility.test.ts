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

const legacyConnector = {
  id: "00000000-0000-4000-a000-000000000002",
  type: "github",
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

const legacyCatalogItem = {
  connectorRef: "github",
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

describe("connector client response compatibility", () => {
  it("keeps legacy-only response payloads readable", () => {
    expect(connectorResponseSchema.safeParse(legacyConnector).success).toBe(
      true,
    );
    expect(
      connectorListResponseSchema.safeParse({
        connectors: [legacyConnector],
        configuredTypes: ["github"],
        connectorProvidedBindings: [
          {
            connectorType: "github",
            authMethod: "oauth",
            namespace: "secrets",
            name: "GITHUB_TOKEN",
            optional: false,
            source: { kind: "connector-secret", name: "accessToken" },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      connectorOauthDeviceAuthSessionStartResponseSchema.safeParse({
        sessionId: "00000000-0000-4000-a000-000000000003",
        sessionToken: "session-token",
        type: "github",
        status: "pending",
        userCode: "ABCD-EFGH",
        verificationUri: "https://example.test/device",
        expiresIn: 600,
        interval: 5,
      }).success,
    ).toBe(true);
    expect(
      connectorExternalCodeSessionStartResponseSchema.safeParse({
        sessionId: "00000000-0000-4000-a000-000000000004",
        sessionToken: "session-token",
        type: "aws",
        status: "pending",
        authorizationUrl: "https://example.test/authorize",
        expiresIn: 600,
      }).success,
    ).toBe(true);
    expect(
      zeroConnectorsSearchContract.search.responses[200].safeParse({
        connectors: [
          {
            id: "github",
            label: "GitHub",
            description: "GitHub connector",
            authMethods: ["oauth"],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      zeroConnectorCatalogContract.list.responses[200].safeParse({
        connectors: [legacyCatalogItem],
      }).success,
    ).toBe(true);
    expect(
      zeroConnectorCatalogContract.permissions.responses[200].safeParse({
        permissions: {
          connectorRef: "github",
          label: "GitHub",
          icon: legacyCatalogItem.icon,
          permissionCount: 0,
          permissions: [],
          categories: null,
          defaultPolicy: {
            permissionDefault: "ask",
            unknownPolicy: "ask",
          },
        },
      }).success,
    ).toBe(true);
    expect(
      connectorCheckDiagnosticResultSchema.safeParse({
        outcome: "resolved",
        mode: "url",
        connector: {
          connectorRef: "github",
          label: "GitHub",
          visibility: "available",
          credentialResolution: "network-boundary",
        },
        environmentNames: null,
        run: { status: "not-scoped" },
        method: "GET",
        base: "https://api.github.com",
        relativePath: "/user",
        permission: {
          kind: "unknown-endpoint",
          policy: { outcome: "allow", basis: "no-policy" },
        },
      }).success,
    ).toBe(true);
    expect(
      connectorCheckDiagnosticResultSchema.safeParse({
        outcome: "ambiguous",
        candidates: [
          { connectorRef: "github", label: "GitHub" },
          { connectorRef: "gitlab", label: "GitLab" },
        ],
      }).success,
    ).toBe(true);
    expect(
      userConnectorEnabledSlugsSchema.safeParse({
        enabledTypes: ["github"],
      }).success,
    ).toBe(true);
    expect(
      userPermissionGrantResponseSchema.safeParse({
        agentId: AGENT_ID,
        connectorRef: "github",
        permission: "contents:read",
        action: "allow",
        expiresAt: null,
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      zeroWorkflowConnectorReadinessResponseSchema.safeParse({
        connectors: [
          {
            connectorRef: "github",
            label: "GitHub",
            icon: legacyCatalogItem.icon,
            reason: "Connect GitHub",
            status: "not-connected",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      connectorChangedPayloadSchema.safeParse({
        connectorRef: "github",
      }).success,
    ).toBe(true);
  });
});

describe("connector client request compatibility", () => {
  it("normalizes legacy, canonical, and matching dual connector checks", () => {
    const base = {
      mode: "url" as const,
      method: "GET",
      url: "https://api.github.com/user",
    };

    expect(
      connectorCheckRequestSchema.parse({
        ...base,
        connectorRef: "github",
      }),
    ).toStrictEqual({
      ...base,
      connectorRef: "github",
      connectorSlug: "github",
    });
    expect(
      connectorCheckRequestSchema.parse({
        ...base,
        connectorSlug: "github",
      }),
    ).toStrictEqual({
      ...base,
      connectorRef: "github",
      connectorSlug: "github",
    });
    expect(
      connectorCheckRequestSchema.parse({
        ...base,
        connectorRef: "github",
        connectorSlug: "github",
      }),
    ).toStrictEqual({
      ...base,
      connectorRef: "github",
      connectorSlug: "github",
    });
    expect(connectorCheckRequestSchema.parse(base)).toStrictEqual(base);
    expect(
      connectorCheckRequestSchema.safeParse({
        ...base,
        connectorRef: "github",
        connectorSlug: "gitlab",
      }).success,
    ).toBe(false);
  });

  it("normalizes valid user connector updates and rejects ambiguous input", () => {
    expect(
      userConnectorUpdateSchema.parse({ enabledTypes: ["github"] }),
    ).toStrictEqual({
      enabledTypes: ["github"],
      enabledConnectorSlugs: ["github"],
    });
    expect(
      userConnectorUpdateSchema.parse({
        enabledConnectorSlugs: ["github"],
      }),
    ).toStrictEqual({
      enabledTypes: ["github"],
      enabledConnectorSlugs: ["github"],
    });
    expect(
      userConnectorUpdateSchema.parse({
        enabledTypes: ["github"],
        enabledConnectorSlugs: ["github"],
        operation: "add",
      }),
    ).toStrictEqual({
      enabledTypes: ["github"],
      enabledConnectorSlugs: ["github"],
      operation: "add",
    });
    expect(userConnectorUpdateSchema.safeParse({}).success).toBe(false);
    expect(
      userConnectorUpdateSchema.safeParse({
        enabledTypes: ["github", "gitlab"],
        enabledConnectorSlugs: ["gitlab", "github"],
      }).success,
    ).toBe(false);
  });

  it("normalizes valid permission grant requests and rejects ambiguity", () => {
    const base = {
      agentId: AGENT_ID,
      mode: "patch" as const,
      grants: [{ permission: "contents:read", action: "allow" as const }],
    };

    expect(
      applyUserPermissionGrantsRequestSchema.parse({
        ...base,
        connectorRef: "github",
      }),
    ).toStrictEqual({
      ...base,
      connectorRef: "github",
      connectorSlug: "github",
    });
    expect(
      applyUserPermissionGrantsRequestSchema.parse({
        ...base,
        connectorSlug: "github",
      }),
    ).toStrictEqual({
      ...base,
      connectorRef: "github",
      connectorSlug: "github",
    });
    expect(
      applyUserPermissionGrantsRequestSchema.parse({
        ...base,
        connectorRef: "github",
        connectorSlug: "github",
      }),
    ).toStrictEqual({
      ...base,
      connectorRef: "github",
      connectorSlug: "github",
    });
    expect(applyUserPermissionGrantsRequestSchema.safeParse(base).success).toBe(
      false,
    );
    expect(
      applyUserPermissionGrantsRequestSchema.safeParse({
        ...base,
        connectorRef: "github",
        connectorSlug: "gitlab",
      }).success,
    ).toBe(false);
  });
});

describe("connector path parameter compatibility", () => {
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
