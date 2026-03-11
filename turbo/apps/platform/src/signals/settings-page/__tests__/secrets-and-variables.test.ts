import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mergedItems$ } from "../secrets-and-variables.ts";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";

const context = testContext();

describe("mergedItems$", () => {
  it("should return configured secrets and variables", async () => {
    server.use(
      http.get("http://localhost:3000/api/secrets", () => {
        return HttpResponse.json({
          secrets: [
            {
              id: "s1",
              name: "API_KEY",
              description: "key",
              type: "user",
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
          ],
        });
      }),
      http.get("http://localhost:3000/api/variables", () => {
        return HttpResponse.json({
          variables: [
            {
              id: "v1",
              name: "MY_VAR",
              value: "val",
              description: null,
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
          ],
        });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    const items = await context.store.get(mergedItems$);

    expect(items).toHaveLength(2);

    const secret = items.find(
      (i) => i.kind === "secret" && i.name === "API_KEY",
    );
    expect(secret).toBeDefined();
    expect(secret!.data).not.toBeNull();

    const variable = items.find(
      (i) => i.kind === "variable" && i.name === "MY_VAR",
    );
    expect(variable).toBeDefined();
    expect(variable!.data).not.toBeNull();
  });

  it("should return empty array when no secrets or variables exist", async () => {
    server.use(
      http.get("http://localhost:3000/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("http://localhost:3000/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    const items = await context.store.get(mergedItems$);
    expect(items).toHaveLength(0);
  });

  it("should exclude secrets and variables managed by connected connectors", async () => {
    server.use(
      http.get("/api/connectors", () => {
        return HttpResponse.json({
          connectors: [
            {
              id: "conn-1",
              type: "atlassian",
              authMethod: "api-token",
              externalId: null,
              externalUsername: null,
              externalEmail: null,
              oauthScopes: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          configuredTypes: Object.keys(CONNECTOR_TYPES) as ConnectorType[],
          connectorProvidedSecretNames: [],
        });
      }),
      http.get("http://localhost:3000/api/secrets", () => {
        return HttpResponse.json({
          secrets: [
            {
              id: "s1",
              name: "ATLASSIAN_TOKEN",
              description: null,
              type: "user",
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
            {
              id: "s2",
              name: "MY_CUSTOM_KEY",
              description: null,
              type: "user",
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
          ],
        });
      }),
      http.get("http://localhost:3000/api/variables", () => {
        return HttpResponse.json({
          variables: [
            {
              id: "v1",
              name: "ATLASSIAN_EMAIL",
              value: "test@example.com",
              description: null,
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
            {
              id: "v2",
              name: "ATLASSIAN_DOMAIN",
              value: "mycompany",
              description: null,
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
            {
              id: "v3",
              name: "MY_CUSTOM_VAR",
              value: "custom",
              description: null,
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
          ],
        });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    const items = await context.store.get(mergedItems$);

    // Only custom (non-connector) items should remain
    const names = items.map((i) => i.name);
    expect(names).toContain("MY_CUSTOM_KEY");
    expect(names).toContain("MY_CUSTOM_VAR");
    expect(names).not.toContain("ATLASSIAN_TOKEN");
    expect(names).not.toContain("ATLASSIAN_EMAIL");
    expect(names).not.toContain("ATLASSIAN_DOMAIN");
    expect(items).toHaveLength(2);
  });
});
