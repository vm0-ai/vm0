import { describe, expect, it } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import type { ConnectorResponse } from "@vm0/core";
import {
  connectorItems$,
  manualItems$,
  allConnectorsSatisfied$,
  autoSuccess$,
  formErrors$,
  isSuccess$,
  submitForm$,
  updateFormValue$,
} from "../environment-variables-setup.ts";

const context = testContext();

function makeConnector(type: "github" | "notion"): ConnectorResponse {
  return {
    id: crypto.randomUUID(),
    type,
    authMethod: "oauth",
    platform: "self-hosted",
    externalId: `ext-${type}-1`,
    externalUsername: type === "github" ? "octocat" : "notion-user",
    externalEmail: null,
    oauthScopes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("connectorItems$", () => {
  it("groups missing connector-provided secrets by connector type", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=GH_TOKEN,NOTION_TOKEN",
    });

    const items = await context.store.get(connectorItems$);

    expect(items).toHaveLength(2);

    const github = items.find((i) => i.connectorType === "github");
    expect(github).toBeDefined();
    expect(github!.label).toBe("GitHub");
    expect(github!.envVars).toContain("GH_TOKEN");
    expect(github!.connected).toBeFalsy();

    const notion = items.find((i) => i.connectorType === "notion");
    expect(notion).toBeDefined();
    expect(notion!.label).toBe("Notion");
    expect(notion!.envVars).toContain("NOTION_TOKEN");
    expect(notion!.connected).toBeFalsy();
  });

  it("marks connector as connected when user has that connector", async () => {
    setMockConnectors([makeConnector("github")]);

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=GH_TOKEN",
    });

    const items = await context.store.get(connectorItems$);

    expect(items).toHaveLength(1);
    expect(items[0].connectorType).toBe("github");
    expect(items[0].connected).toBeTruthy();
  });

  it("returns empty array when no missing items map to connectors", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=MY_CUSTOM_KEY",
    });

    const items = await context.store.get(connectorItems$);

    expect(items).toHaveLength(0);
  });

  it("groups multiple env vars under the same connector type", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=GH_TOKEN,GITHUB_TOKEN",
    });

    const items = await context.store.get(connectorItems$);

    expect(items).toHaveLength(1);
    expect(items[0].connectorType).toBe("github");
    expect(items[0].envVars).toContain("GH_TOKEN");
    expect(items[0].envVars).toContain("GITHUB_TOKEN");
  });
});

describe("manualItems$", () => {
  it("returns only items that have no connector mapping", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=GH_TOKEN,MY_API_KEY&vars=MY_VAR",
    });

    const manual = await context.store.get(manualItems$);

    expect(manual).toHaveLength(2);
    expect(manual.map((m) => m.name).sort()).toStrictEqual([
      "MY_API_KEY",
      "MY_VAR",
    ]);
  });

  it("returns empty array when all missing items are connector-provided", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=GH_TOKEN,NOTION_TOKEN",
    });

    const manual = await context.store.get(manualItems$);

    expect(manual).toHaveLength(0);
  });
});

describe("allConnectorsSatisfied$", () => {
  it("returns true when all required connectors are connected", async () => {
    setMockConnectors([makeConnector("github"), makeConnector("notion")]);

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=GH_TOKEN,NOTION_TOKEN",
    });

    const satisfied = await context.store.get(allConnectorsSatisfied$);

    expect(satisfied).toBeTruthy();
  });

  it("returns false when a required connector is not connected", async () => {
    setMockConnectors([makeConnector("github")]);

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=GH_TOKEN,NOTION_TOKEN",
    });

    const satisfied = await context.store.get(allConnectorsSatisfied$);

    expect(satisfied).toBeFalsy();
  });

  it("returns true when no connector items exist", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=MY_CUSTOM_KEY",
    });

    const satisfied = await context.store.get(allConnectorsSatisfied$);

    expect(satisfied).toBeTruthy();
  });
});

describe("autoSuccess$", () => {
  it("returns true when all connectors are connected and no manual items remain", async () => {
    setMockConnectors([makeConnector("github")]);

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=GH_TOKEN",
    });

    const auto = await context.store.get(autoSuccess$);

    expect(auto).toBeTruthy();
  });

  it("returns false when manual items remain", async () => {
    setMockConnectors([makeConnector("github")]);

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=GH_TOKEN,MY_CUSTOM_KEY",
    });

    const auto = await context.store.get(autoSuccess$);

    expect(auto).toBeFalsy();
  });

  it("returns false when no connector items exist at all", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=MY_CUSTOM_KEY",
    });

    const auto = await context.store.get(autoSuccess$);

    expect(auto).toBeFalsy();
  });

  it("returns false when connectors are not all connected", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=GH_TOKEN",
    });

    const auto = await context.store.get(autoSuccess$);

    expect(auto).toBeFalsy();
  });
});

describe("submitForm$", () => {
  it("does not submit when connectors are not satisfied", async () => {
    let requestCount = 0;

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
      http.put("/api/secrets", () => {
        requestCount++;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=GH_TOKEN,MY_CUSTOM_KEY",
    });

    // Fill in the manual field value
    await context.store.set(updateFormValue$, "MY_CUSTOM_KEY", "test-value");

    // Try to submit - should be blocked because github connector is not connected
    await context.store.set(submitForm$, context.signal);

    expect(requestCount).toBe(0);
  });

  it("submits only manual items when connectors are satisfied", async () => {
    setMockConnectors([makeConnector("github")]);

    const capturedBodies: { name: string; value: string }[] = [];

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
      http.put("/api/secrets", async ({ request }) => {
        const body = (await request.json()) as { name: string; value: string };
        capturedBodies.push(body);
        return HttpResponse.json(
          {
            id: crypto.randomUUID(),
            name: body.name,
            description: null,
            type: "user",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          { status: 201 },
        );
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=GH_TOKEN,MY_CUSTOM_KEY",
    });

    await context.store.set(updateFormValue$, "MY_CUSTOM_KEY", "secret-value");

    await context.store.set(submitForm$, context.signal);

    // Only manual item should be submitted, not the connector-provided one
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].name).toBe("MY_CUSTOM_KEY");
    expect(capturedBodies[0].value).toBe("secret-value");

    // Should be marked as success
    expect(context.store.get(isSuccess$)).toBeTruthy();
  });

  it("sets validation errors when manual fields are empty", async () => {
    setMockConnectors([makeConnector("github")]);

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=GH_TOKEN,MY_CUSTOM_KEY",
    });

    // Do not fill in value, just try to submit
    await context.store.set(submitForm$, context.signal);

    const errors = context.store.get(formErrors$);
    expect(errors).toHaveProperty("MY_CUSTOM_KEY");
    expect(errors.MY_CUSTOM_KEY).toBe("MY_CUSTOM_KEY is required");
  });

  it("submits successfully when only connector items exist and all are connected", async () => {
    setMockConnectors([makeConnector("github")]);

    let requestCount = 0;

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
      http.put("/api/secrets", () => {
        requestCount++;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await setupPage({
      context,
      withoutRender: true,
      path: "/environment-variables-setup?secrets=GH_TOKEN",
    });

    await context.store.set(submitForm$, context.signal);

    // No manual items to submit
    expect(requestCount).toBe(0);
    // Should still succeed
    expect(context.store.get(isSuccess$)).toBeTruthy();
  });
});
