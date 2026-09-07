import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";

import type { ConnectorAuthMethodRuntimeConfig } from "../../connector-config";
import {
  exchangeConnectorAuthCodeWithMethod,
  refreshConnectorAuthProviderAccessTokenWithMethod,
} from "../connector-auth";
import { ProviderResponseError } from "../provider-error";
import { server } from "./test-server";

interface ProviderCase {
  readonly slug: string;
  readonly methodId: string;
  readonly url: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly rotates: boolean;
  readonly clientEnv?: string;
}

const PROVIDERS: readonly ProviderCase[] = [
  {
    slug: "paypal",
    methodId: "api-token",
    url: "https://api-m.paypal.com/v1/oauth2/token",
    inputs: { clientId: "client-id", clientSecret: "client-secret" },
    rotates: false,
  },
  {
    slug: "ramp",
    methodId: "api-token",
    url: "https://api.ramp.com/developer/v1/token",
    inputs: {
      clientId: "client-id",
      clientSecret: "client-secret",
      scope: "transactions:read",
    },
    rotates: false,
  },
  {
    slug: "netsuite",
    methodId: "api-token",
    url: "https://test-account.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token",
    inputs: {
      accountSubdomain: "test-account",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    },
    rotates: true,
  },
  {
    slug: "reckon",
    methodId: "oauth-refresh-token",
    url: "https://identity.reckon.com/connect/token",
    inputs: {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://example.com/callback",
      refreshToken: "refresh-token",
    },
    rotates: true,
  },
  {
    slug: "resource-guru",
    methodId: "oauth",
    url: "https://api.resourceguruapp.com/oauth/token",
    inputs: { refreshToken: "refresh-token" },
    rotates: true,
    clientEnv: "RESOURCE_GURU",
  },
  {
    slug: "optimizely-cmp",
    methodId: "oauth",
    url: "https://accounts.cmp.optimizely.com/o/oauth2/v1/token",
    inputs: { refreshToken: "refresh-token" },
    rotates: true,
    clientEnv: "OPTIMIZELY_CMP",
  },
];

const AUTH_CLIENT = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "client-id",
  clientSecret: "client-secret",
} as const;

function secretRef(name: string) {
  return `$secrets.TEST_${name.toUpperCase()}` as const;
}

function selection(provider: ProviderCase) {
  const outputs = {
    accessToken: secretRef("accessToken"),
    ...(provider.rotates ? { refreshToken: secretRef("refreshToken") } : {}),
  };
  const inputNames = Object.keys(provider.inputs);
  const shared: Pick<
    ConnectorAuthMethodRuntimeConfig,
    "storage" | "access" | "revoke"
  > = {
    storage: {
      version: 1,
      secrets: [
        ...new Set(
          [...inputNames, ...Object.keys(outputs)].map((name) => {
            return `TEST_${name.toUpperCase()}`;
          }),
        ),
      ],
      variables: [],
    },
    access: {
      kind: "refresh-token",
      inputs: Object.fromEntries(
        inputNames.map((name) => {
          return [name, secretRef(name)];
        }),
      ),
      outputs,
      refreshableSecrets: ["TEST_ACCESSTOKEN"],
      envBindings: {},
    },
    revoke:
      provider.slug === "optimizely-cmp"
        ? {
            kind: "token-revoke",
            inputs: { refreshToken: secretRef("refreshToken") },
          }
        : { kind: "none" },
  };
  const method: ConnectorAuthMethodRuntimeConfig = provider.clientEnv
    ? {
        ...shared,
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: `${provider.clientEnv}_OAUTH_CLIENT_ID`,
          clientSecretEnv: `${provider.clientEnv}_OAUTH_CLIENT_SECRET`,
        },
        grant: {
          kind: "auth-code",
          callbackOrigin: "web",
          scopes: [],
          outputs,
        },
      }
    : {
        ...shared,
        grant: {
          kind: "manual",
          fields: Object.fromEntries(
            inputNames.map((name) => {
              return [
                `TEST_${name.toUpperCase()}`,
                {
                  publicId: name,
                  label: name,
                  required: true,
                  storage: "secret" as const,
                },
              ];
            }),
          ),
        },
      };
  return {
    connectorSlug: provider.slug,
    authMethodId: provider.methodId,
    method,
    inputs: provider.inputs,
    ...(provider.clientEnv ? { authClient: AUTH_CLIENT } : {}),
  };
}

const INVALID_RESPONSES = [
  { label: "malformed JSON", body: "PRIVATE123" },
  {
    label: "invalid token types",
    body: JSON.stringify({ access_token: 42, expires_in: 3600 }),
  },
  {
    label: "missing required tokens",
    body: JSON.stringify({ expires_in: 3600 }),
  },
];

function invalidResponses(provider: ProviderCase) {
  if (provider.slug === "optimizely-cmp") {
    return [
      ...INVALID_RESPONSES,
      {
        label: "a missing refresh token",
        body: JSON.stringify({ access_token: "PRIVATE123", expires_in: 3600 }),
      },
    ];
  }
  return INVALID_RESPONSES;
}

describe.each(PROVIDERS)("registered $slug token responses", (provider) => {
  it.each(invalidResponses(provider))(
    "sanitizes $label as an upstream response error",
    async ({ body }) => {
      server.use(
        http.post(provider.url, () => {
          return new HttpResponse(body);
        }),
      );
      const refresh = refreshConnectorAuthProviderAccessTokenWithMethod(
        selection(provider),
        new AbortController().signal,
      );
      await expect(refresh).rejects.toBeInstanceOf(ProviderResponseError);
      await expect(refresh).rejects.toHaveProperty(
        "message",
        expect.not.stringContaining("PRIVATE123"),
      );
      await expect(refresh).rejects.toHaveProperty(
        "message",
        expect.not.stringContaining("access_token"),
      );
    },
  );

  it("preserves successful token outputs, rotation and expiry", async () => {
    server.use(
      http.post(provider.url, () => {
        return HttpResponse.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        });
      }),
    );
    await expect(
      refreshConnectorAuthProviderAccessTokenWithMethod(
        selection(provider),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      outputs: {
        accessToken: "new-access",
        ...(provider.rotates ? { refreshToken: "new-refresh" } : {}),
      },
      expiresIn: 3600,
    });
  });

  it("preserves HTTP failure status", async () => {
    server.use(
      http.post(provider.url, () => {
        return HttpResponse.json({ error: "invalid_grant" }, { status: 401 });
      }),
    );
    await expect(
      refreshConnectorAuthProviderAccessTokenWithMethod(
        selection(provider),
        new AbortController().signal,
      ),
    ).rejects.toHaveProperty("status", 401);
  });

  it("preserves network failures", async () => {
    server.use(
      http.post(provider.url, () => {
        return HttpResponse.error();
      }),
    );
    await expect(
      refreshConnectorAuthProviderAccessTokenWithMethod(
        selection(provider),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("preserves cancellation while reading the response body", async () => {
    const abort = new DOMException("Response body cancelled", "AbortError");
    server.use(
      http.post(provider.url, () => {
        return new HttpResponse(
          new ReadableStream({
            start(controller) {
              controller.error(abort);
            },
          }),
        );
      }),
    );
    await expect(
      refreshConnectorAuthProviderAccessTokenWithMethod(
        selection(provider),
        new AbortController().signal,
      ),
    ).rejects.toBe(abort);
  });
});

describe.each(
  PROVIDERS.filter((provider) => {
    return provider.clientEnv;
  }),
)("registered $slug code exchange", (provider) => {
  it.each(invalidResponses(provider))(
    "sanitizes $label before fetching user information",
    async ({ body }) => {
      server.use(
        http.post(provider.url, () => {
          return new HttpResponse(body);
        }),
      );
      await expect(
        exchangeConnectorAuthCodeWithMethod({
          ...selection(provider),
          authClient: AUTH_CLIENT,
          code: "authorization-code",
          redirectUri: "https://example.com/callback",
          authorizationUrl: null,
          state: "state",
          codeVerifier: undefined,
          oauthContext: undefined,
        }),
      ).rejects.toBeInstanceOf(ProviderResponseError);
    },
  );
});
