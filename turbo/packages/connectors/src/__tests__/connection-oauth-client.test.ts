import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { resolveConnectorAuthClient } from "../connector-auth-method";
import type { ConnectorAuthMethodRuntimeConfig } from "../connector-config";
import type { ConnectorCatalogAuthMethod } from "../connector-catalog/artifacts/artifacts";
import { refreshConnectorAuthProviderAccessTokenWithMethod } from "../auth-providers/connector-auth";
import { server } from "../auth-providers/__tests__/test-server";
import {
  connectorSourceSchema,
  validateConnectorSourceSemantics,
} from "../connector-catalog/artifacts/source";

function method() {
  return {
    id: "oauth-client",
    label: "User OAuth",
    description: null,
    visible: true,
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdInput: "clientId",
      clientSecretInput: "clientSecret",
    },
    storage: {
      version: 1,
      secrets: ["ACCESS", "REFRESH", "CLIENT_ID", "CLIENT_SECRET"],
      variables: [],
    },
    grant: {
      kind: "auth-code",
      callbackOrigin: "web",
      scopes: ["openid", "profile", "offline_access"],
      outputs: {
        accessToken: "$secrets.ACCESS",
        refreshToken: "$secrets.REFRESH",
        clientId: "$secrets.CLIENT_ID",
        clientSecret: "$secrets.CLIENT_SECRET",
      },
    },
    access: {
      kind: "refresh-token",
      envBindings: { CMP_TOKEN: "$secrets.ACCESS" },
      inputs: {
        refreshToken: "$secrets.REFRESH",
        clientId: "$secrets.CLIENT_ID",
        clientSecret: "$secrets.CLIENT_SECRET",
      },
      outputs: {
        accessToken: "$secrets.ACCESS",
        refreshToken: "$secrets.REFRESH",
      },
      refreshableSecrets: ["ACCESS"],
    },
    revoke: {
      kind: "token-revoke",
      inputs: {
        refreshToken: "$secrets.REFRESH",
        clientId: "$secrets.CLIENT_ID",
        clientSecret: "$secrets.CLIENT_SECRET",
      },
    },
  } satisfies ConnectorCatalogAuthMethod & ConnectorAuthMethodRuntimeConfig;
}

function validate(authMethod: ConnectorCatalogAuthMethod) {
  const source = connectorSourceSchema.parse({
    label: "CMP",
    description: "CMP user OAuth",
    category: "marketing",
    generation: [],
    tags: [],
    authMethods: [authMethod],
  });
  validateConnectorSourceSemantics({ connectorSlug: "optimizely-cmp", source });
}

describe("connection OAuth client contract", () => {
  it("accepts encrypted client bindings and keeps legacy environment clients readable", () => {
    validate(method());
    const legacy = {
      ...method(),
      id: "oauth",
      client: {
        clientRegistration: "static" as const,
        clientType: "confidential" as const,
        clientIdEnv: "CLIENT_ID",
        clientSecretEnv: "CLIENT_SECRET",
      },
    };
    validate(legacy);
    expect(
      resolveConnectorAuthClient(legacy.client, (name) => {
        return name === "CLIENT_ID" ? "legacy-id" : "legacy-secret";
      }),
    ).toMatchObject({ clientId: "legacy-id", clientSecret: "legacy-secret" });
    expect(
      resolveConnectorAuthClient(method().client, () => {
        return "must-not-fall-back";
      }),
    ).toBeUndefined();
  });

  it.each(["clientId", "clientSecret"] as const)(
    "rejects a %s mapped to a different refresh credential",
    (input) => {
      const config = method();
      expect(() => {
        return validate({
          ...config,
          access: {
            ...config.access,
            inputs: { ...config.access.inputs, [input]: "$secrets.REFRESH" },
          },
        });
      }).toThrow("same encrypted grant, refresh and revoke storage");
    },
  );

  it("rejects a client credential exposed to the sandbox", () => {
    const config = method();
    expect(() => {
      return validate({
        ...config,
        access: {
          ...config.access,
          envBindings: { CMP_TOKEN: "$secrets.CLIENT_SECRET" },
        },
      });
    }).toThrow("runtime environment bindings");
  });

  it("rejects aliased client ID and secret storage", () => {
    const config = method();
    expect(() => {
      return validate({
        ...config,
        grant: {
          ...config.grant,
          outputs: {
            ...config.grant.outputs,
            clientId: "$secrets.CLIENT_SECRET",
          },
        },
      });
    }).toThrow("separate encrypted storage");
  });

  it("refreshes with the client from the same input snapshot even if a caller supplies a stale client", async () => {
    server.use(
      http.post(
        "https://accounts.cmp.optimizely.com/o/oauth2/v1/token",
        async ({ request }) => {
          expect(await request.json()).toEqual({
            grant_type: "refresh_token",
            client_id: "connection-id",
            client_secret: "connection-secret",
            refresh_token: "connection-refresh",
          });
          return HttpResponse.json({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          });
        },
      ),
    );
    const result = await refreshConnectorAuthProviderAccessTokenWithMethod(
      {
        connectorSlug: "optimizely-cmp",
        authMethodId: "oauth-client",
        method: method(),
        authClient: {
          clientRegistration: "static",
          clientType: "confidential",
          clientId: "stale-id",
          clientSecret: "stale-secret",
        },
        inputs: {
          clientId: "connection-id",
          clientSecret: "connection-secret",
          refreshToken: "connection-refresh",
        },
      },
      new AbortController().signal,
    );
    expect(result.outputs).toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
  });

  it("rejects a refresh that overwrites the application's credentials", () => {
    const config = method();
    expect(() => {
      return validate({
        ...config,
        access: {
          ...config.access,
          outputs: {
            ...config.access.outputs,
            refreshToken: "$secrets.CLIENT_SECRET",
          },
        },
      });
    }).toThrow("cannot share token output storage");
  });
});
