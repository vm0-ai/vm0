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
import { connectorCatalogContract } from "../connector-catalog";
import { connectorAccountsContract } from "../connector-accounts";
import {
  connectorCheckDiagnosticResultSchema,
  connectorCheckRequestSchema,
} from "../connector-check";
import { connectorsSearchContract } from "../connectors";
import {
  customConnectorListResponseSchema,
  customConnectorResponseSchema,
  createCustomConnectorBodySchema,
} from "../custom-connectors";
import {
  applyUserPermissionGrantsRequestSchema,
  userPermissionGrantResponseSchema,
} from "../user-permission-grants";
import { initClient } from "../trpc-contract";

const AGENT_ID = "00000000-0000-4000-a000-000000000001";

const customHttpConnectorPayloadBase = {
  id: "00000000-0000-4000-a000-000000000005",
  slug: "_example",
  displayName: "Example",
  fields: [
    {
      key: "token",
      label: "Token",
      kind: "secret",
      required: true,
    },
  ],
  headerInjections: [
    { name: "Authorization", valueTemplate: "Bearer {{token}}" },
  ],
  queryInjections: [],
  authMode: "manual",
  permissionBundleRef: null,
  skillMarkdown: null,
  storageVersion: 1,
  connected: true,
  missingRequiredFields: [],
  configuredFieldKeys: ["token"],
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  prefixTemplates: ["https://api.example.test"],
} as const;

const customHttpConnectorPayload = {
  ...customHttpConnectorPayloadBase,
  kind: "http",
} as const;

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
    ).toMatchObject({
      connectorProvidedBindings: [
        { connectorSlug: "github", name: "GITHUB_TOKEN" },
      ],
    });
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
      connectorsSearchContract.search.responses[200].parse({
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
      connectorCatalogContract.list.responses[200].parse({
        connectors: [catalogItem],
      }),
    ).toMatchObject({ connectors: [{ slug: "github" }] });
    expect(
      connectorCatalogContract.permissions.responses[200].parse({
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
      connectorChangedPayloadSchema.parse({ connectorSlug: "github" }),
    ).toStrictEqual({ connectorSlug: "github" });
  });
});

describe("custom connector response contracts", () => {
  it("requires tagged HTTP responses", () => {
    expect(
      customConnectorResponseSchema.parse(customHttpConnectorPayload),
    ).toStrictEqual(customHttpConnectorPayload);
    expect(
      customConnectorListResponseSchema.parse({
        connectors: [customHttpConnectorPayload],
      }),
    ).toStrictEqual({ connectors: [customHttpConnectorPayload] });
    expect(() => {
      customConnectorResponseSchema.parse(customHttpConnectorPayloadBase);
    }).toThrow();
  });

  it("parses canonical OAuth HTTP responses", () => {
    const payload = {
      ...customHttpConnectorPayload,
      authMode: "oauth",
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "oauth-client-id",
        authorizationUrl: "https://example.test/oauth/authorize",
        tokenUrl: "https://example.test/oauth/token",
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "S256",
        scopes: ["read"],
        authorizationParams: {},
      },
    } as const;

    expect(customConnectorResponseSchema.parse(payload)).toStrictEqual(payload);

    expect(
      customConnectorResponseSchema.parse({
        ...payload,
        oauthSetup: "custom",
      }),
    ).toStrictEqual(payload);
  });

  it("parses top-level Automatic MCP authentication", () => {
    const payload = {
      id: "00000000-0000-4000-a000-000000000006",
      slug: "_example-mcp",
      displayName: "Example MCP",
      kind: "mcp",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic",
      permissionBundleRef: null,
      skillMarkdown: null,
      storageVersion: 1,
      connected: false,
      missingRequiredFields: [],
      configuredFieldKeys: [],
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      endpoint: "https://mcp.example.test",
      transport: "streamable-http",
      prefixTemplates: [],
    } as const;

    expect(customConnectorResponseSchema.parse(payload)).toStrictEqual(payload);
  });

  it("rejects responses without an auth mode", () => {
    const { authMode: _authMode, ...payload } = customHttpConnectorPayload;

    expect(() => {
      return customConnectorResponseSchema.parse(payload);
    }).toThrow();
  });

  it("parses canonical MCP responses", () => {
    const payload = {
      id: "00000000-0000-4000-a000-000000000006",
      slug: "_example-mcp",
      displayName: "Example MCP",
      kind: "mcp",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "manual",
      permissionBundleRef: null,
      skillMarkdown: null,
      storageVersion: 1,
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: [],
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      endpoint: "https://mcp.example.test",
      transport: "streamable-http",
      prefixTemplates: [],
    } as const;
    expect(customConnectorResponseSchema.parse(payload)).toStrictEqual(payload);
  });
});

describe("connector client request contracts", () => {
  const definitionBase = {
    displayName: "Example MCP",
    kind: "mcp" as const,
    endpoint: "https://mcp.example.test",
    transport: "streamable-http" as const,
  };
  const oauthDefinition = {
    ...definitionBase,
    fields: [],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{oauth.access_token}}",
      },
    ],
    queryInjections: [],
  };
  const manualDefinition = {
    ...definitionBase,
    fields: [
      {
        key: "token",
        label: "Token",
        kind: "secret" as const,
        required: true,
      },
    ],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{token}}" },
    ],
    queryInjections: [],
  };

  it("normalizes legacy custom OAuth writes and accepts automatic MCP writes", () => {
    const oauthConfig = {
      providerAdapter: "standard" as const,
      clientId: "oauth-client-id",
      clientSecret: "oauth-client-secret",
      authorizationUrl: "https://example.test/oauth/authorize",
      tokenUrl: "https://example.test/oauth/token",
      tokenEndpointAuthMethod: "client_secret_post" as const,
      pkceMethod: "S256" as const,
      scopes: ["read"],
      authorizationParams: {},
    };

    expect(
      createCustomConnectorBodySchema.parse({
        ...oauthDefinition,
        authMode: "oauth",
        oauthConfig,
      }),
    ).toMatchObject({ authMode: "oauth", oauthConfig });
    expect(
      createCustomConnectorBodySchema.parse({
        ...oauthDefinition,
        fields: [],
        headerInjections: [],
        queryInjections: [],
        authMode: "automatic",
      }),
    ).toMatchObject({ authMode: "automatic" });
  });

  it("keeps additive request fields forward-compatible", () => {
    expect(
      createCustomConnectorBodySchema.parse({
        ...manualDefinition,
        authMode: "manual",
        futureOption: true,
      }),
    ).not.toHaveProperty("futureOption");
  });

  it("rejects ambiguous OAuth setup variants", () => {
    const automatic = {
      ...oauthDefinition,
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic",
    } as const;

    expect(() => {
      createCustomConnectorBodySchema.parse({
        ...automatic,
        oauthConfig: {
          providerAdapter: "standard",
          clientId: "oauth-client-id",
          clientSecret: "oauth-client-secret",
          authorizationUrl: "https://example.test/oauth/authorize",
          tokenUrl: "https://example.test/oauth/token",
          tokenEndpointAuthMethod: "client_secret_post",
          pkceMethod: "S256",
          scopes: [],
          authorizationParams: {},
        },
      });
    }).toThrow();
    expect(() => {
      createCustomConnectorBodySchema.parse({
        ...automatic,
        kind: "http",
        prefixTemplates: ["https://api.example.test"],
      });
    }).toThrow();
    expect(() => {
      createCustomConnectorBodySchema.parse({
        ...manualDefinition,
        authMode: "manual",
        oauthSetup: "custom",
      });
    }).toThrow();
  });

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

    await initClient(connectorAccountsContract, config).disconnectSingleAccount(
      {
        headers: {},
        body: { target: { kind: "builtin", connectorSlug: "github" } },
      },
    );
    await initClient(connectorCatalogContract, config).permissions({
      params: { connectorSlug: "github" },
      headers: {},
    });
    await initClient(connectorsSlugCallbackContract, config).callback({
      params: { connectorSlug: "github" },
      query: { responseMode: "json" },
      headers: {},
    });

    expect(paths).toStrictEqual([
      "https://api.example.test/api/connector-accounts/single-account",
      "https://api.example.test/api/connector-catalog/github/permissions",
      "https://api.example.test/api/connectors/github/callback?responseMode=json",
    ]);
  });
});
