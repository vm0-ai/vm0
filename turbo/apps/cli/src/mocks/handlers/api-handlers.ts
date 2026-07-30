import { http, HttpResponse } from "msw";
import {
  connectorAuthMethodIdSchema,
  type ConnectorAuthMethodId,
} from "@vm0/api-contracts/contracts/connector-identity";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogItem,
  PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isConnectorAuthMethodId(
  value: unknown,
): value is ConnectorAuthMethodId {
  return connectorAuthMethodIdSchema.safeParse(value).success;
}

function defaultPermissionSummary() {
  return {
    hasPermissions: false,
    permissionCount: 0,
    hasCategories: false,
    hasDefaultPolicyOverrides: false,
  };
}

function authCodeMethod(): PublicConnectorCatalogAuthMethodDetail {
  return {
    id: "oauth",
    label: "OAuth",
    description: "Sign in to grant access.",
    grantKind: "auth-code",
    manualFields: [],
    startOptions: [],
  };
}

function manualMethod(
  fields: PublicConnectorCatalogAuthMethodDetail["manualFields"],
): PublicConnectorCatalogAuthMethodDetail {
  return {
    id: "api-token",
    label: "API Token",
    description: "Enter API credentials.",
    grantKind: "manual",
    manualFields: fields,
    startOptions: [],
  };
}

function defaultPublicCatalogStatusItem(args: {
  readonly connectorSlug: string;
  readonly label: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly authMethods?: readonly PublicConnectorCatalogAuthMethodDetail[];
}): PublicConnectorCatalogStatusItem {
  return {
    slug: args.connectorSlug,
    label: args.label,
    description: args.description,
    icon: {
      url: `https://icons.example.test/${args.connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    category: "test-connectors",
    generation: [],
    tags: [...(args.tags ?? [])],
    authMethods: [...(args.authMethods ?? [authCodeMethod()])],
    permissionSummary: defaultPermissionSummary(),
    connection: null,
    connected: false,
    connectionStatus: "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  };
}

const tokenField = {
  id: "apiKey",
  label: "API Key",
  required: true,
  placeholder: null,
  inputType: "password",
} as const;

const defaultPublicCatalogStatus = [
  defaultPublicCatalogStatusItem({
    connectorSlug: "github",
    label: "GitHub",
    description: "Access GitHub repositories.",
    tags: ["vcs", "api"],
  }),
  defaultPublicCatalogStatusItem({
    connectorSlug: "gitlab",
    label: "GitLab",
    description: "Access GitLab repositories.",
    tags: ["vcs"],
  }),
  defaultPublicCatalogStatusItem({
    connectorSlug: "microsoft-365",
    label: "Microsoft 365",
    description: "Access Microsoft 365 collaboration tools.",
    tags: ["chat"],
  }),
  defaultPublicCatalogStatusItem({
    connectorSlug: "slack",
    label: "Slack",
    description: "Send Slack messages.",
    tags: ["chat"],
  }),
  defaultPublicCatalogStatusItem({
    connectorSlug: "chatwoot",
    label: "Chatwoot",
    description: "Manage customer conversations.",
  }),
  defaultPublicCatalogStatusItem({
    connectorSlug: "openai",
    label: "OpenAI",
    description: "Access the OpenAI API.",
    tags: ["chatgpt", "api"],
    authMethods: [manualMethod([tokenField])],
  }),
  defaultPublicCatalogStatusItem({
    connectorSlug: "stripe",
    label: "Stripe",
    description: "Manage payments through the Stripe API.",
    tags: ["api", "payments"],
    authMethods: [authCodeMethod(), manualMethod([tokenField])],
  }),
  defaultPublicCatalogStatusItem({
    connectorSlug: "zendesk",
    label: "Zendesk",
    description: "Manage support data through the Zendesk API.",
    tags: ["api", "support"],
    authMethods: [
      manualMethod([
        {
          id: "apiToken",
          label: "API Token",
          required: true,
          placeholder: null,
          inputType: "password",
        },
        {
          id: "subdomain",
          label: "Subdomain",
          required: true,
          placeholder: null,
          inputType: "text",
        },
        {
          id: "email",
          label: "Email",
          required: true,
          placeholder: null,
          inputType: "text",
        },
      ]),
    ],
  }),
] satisfies readonly PublicConnectorCatalogStatusItem[];

function defaultPublicCatalog(): PublicConnectorCatalogItem[] {
  return defaultPublicCatalogStatus.map((item) => {
    return {
      slug: item.slug,
      label: item.label,
      description: item.description,
      icon: item.icon,
      category: item.category,
      generation: [...item.generation],
      tags: [...item.tags],
      authMethods: item.authMethods.map((authMethod) => {
        return {
          id: authMethod.id,
          label: authMethod.label,
          description: authMethod.description,
          grantKind: authMethod.grantKind,
        };
      }),
      permissionSummary: item.permissionSummary,
    };
  });
}

function manualGrantAuthMethodFromBody(body: unknown): ConnectorAuthMethodId {
  if (isRecord(body) && isConnectorAuthMethodId(body.authMethod)) {
    return body.authMethod;
  }
  return "api-token";
}

function connectorManualGrantResponse(
  connectorSlug: string,
  authMethod: ConnectorAuthMethodId,
) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    type: connectorSlug,
    slug: connectorSlug,
    authMethod,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export const apiHandlers = [
  // GET /api/zero/secrets - listZeroSecrets
  http.get("http://localhost:3000/api/zero/secrets", () => {
    return HttpResponse.json({ secrets: [] }, { status: 200 });
  }),

  // GET /api/zero/variables - listZeroVariables
  http.get("http://localhost:3000/api/zero/variables", () => {
    return HttpResponse.json({ variables: [] }, { status: 200 });
  }),

  // GET /api/zero/connectors - listZeroConnectors
  http.get("http://localhost:3000/api/zero/connectors", () => {
    return HttpResponse.json(
      {
        connectors: [],
        configuredConnectorSlugs: [],
        connectorProvidedBindings: [],
      },
      { status: 200 },
    );
  }),
  http.get("https://www.vm0.ai/api/zero/connectors", () => {
    return HttpResponse.json(
      {
        connectors: [],
        configuredConnectorSlugs: [],
        connectorProvidedBindings: [],
      },
      { status: 200 },
    );
  }),

  // GET /api/zero/connector-catalog - list public connector catalog
  http.get("http://localhost:3000/api/zero/connector-catalog", () => {
    return HttpResponse.json(
      { connectors: defaultPublicCatalog() },
      { status: 200 },
    );
  }),
  http.get("https://app.vm0.ai/api/zero/connector-catalog", () => {
    return HttpResponse.json(
      { connectors: defaultPublicCatalog() },
      { status: 200 },
    );
  }),
  http.get("https://www.vm0.ai/api/zero/connector-catalog", () => {
    return HttpResponse.json(
      { connectors: defaultPublicCatalog() },
      { status: 200 },
    );
  }),

  // GET /api/zero/connector-catalog/status - public catalog with connection status
  http.get("http://localhost:3000/api/zero/connector-catalog/status", () => {
    return HttpResponse.json(
      { connectors: defaultPublicCatalogStatus },
      { status: 200 },
    );
  }),
  http.get("https://app.vm0.ai/api/zero/connector-catalog/status", () => {
    return HttpResponse.json(
      { connectors: defaultPublicCatalogStatus },
      { status: 200 },
    );
  }),
  http.get("https://www.vm0.ai/api/zero/connector-catalog/status", () => {
    return HttpResponse.json(
      { connectors: defaultPublicCatalogStatus },
      { status: 200 },
    );
  }),
  http.post(
    "http://localhost:3000/api/zero/connectors/:connectorSlug/manual-grant",
    async ({ params, request }) => {
      const body: unknown = await request.json();
      return HttpResponse.json(
        connectorManualGrantResponse(
          String(params.connectorSlug),
          manualGrantAuthMethodFromBody(body),
        ),
      );
    },
  ),
  http.post(
    "https://app.vm0.ai/api/zero/connectors/:connectorSlug/manual-grant",
    async ({ params, request }) => {
      const body: unknown = await request.json();
      return HttpResponse.json(
        connectorManualGrantResponse(
          String(params.connectorSlug),
          manualGrantAuthMethodFromBody(body),
        ),
      );
    },
  ),
  http.post(
    "https://www.vm0.ai/api/zero/connectors/:connectorSlug/manual-grant",
    async ({ params, request }) => {
      const body: unknown = await request.json();
      return HttpResponse.json(
        connectorManualGrantResponse(
          String(params.connectorSlug),
          manualGrantAuthMethodFromBody(body),
        ),
      );
    },
  ),

  // GET /api/zero/org - getZeroOrg
  http.get("http://localhost:3000/api/zero/org", () => {
    return HttpResponse.json(
      {
        id: "org-default",
        slug: "user-default",
        displayName: null,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
      { status: 200 },
    );
  }),
];
