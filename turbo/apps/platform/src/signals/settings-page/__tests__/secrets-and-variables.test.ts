import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mergedItems$ } from "../secrets-and-variables.ts";

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
      http.get("http://localhost:3000/api/agent/required-env", () => {
        return HttpResponse.json({ agents: [] });
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
    expect(secret!.agentRequired).toBeFalsy();

    const variable = items.find(
      (i) => i.kind === "variable" && i.name === "MY_VAR",
    );
    expect(variable).toBeDefined();
    expect(variable!.data).not.toBeNull();
    expect(variable!.agentRequired).toBeFalsy();
  });

  it("should include missing required secrets as placeholder items", async () => {
    server.use(
      http.get("http://localhost:3000/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("http://localhost:3000/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
      http.get("http://localhost:3000/api/agent/required-env", () => {
        return HttpResponse.json({
          agents: [
            {
              composeId: "c1",
              agentName: "agent-1",
              requiredSecrets: ["MISSING_KEY"],
              requiredVariables: ["MISSING_VAR"],
            },
          ],
        });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    const items = await context.store.get(mergedItems$);

    const missingSecret = items.find(
      (i) => i.kind === "secret" && i.name === "MISSING_KEY",
    );
    expect(missingSecret).toBeDefined();
    expect(missingSecret!.data).toBeNull();
    expect(missingSecret!.agentRequired).toBeTruthy();

    const missingVar = items.find(
      (i) => i.kind === "variable" && i.name === "MISSING_VAR",
    );
    expect(missingVar).toBeDefined();
    expect(missingVar!.data).toBeNull();
    expect(missingVar!.agentRequired).toBeTruthy();
  });

  it("should hide connector-resolvable missing secrets", async () => {
    server.use(
      http.get("http://localhost:3000/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("http://localhost:3000/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
      http.get("http://localhost:3000/api/agent/required-env", () => {
        return HttpResponse.json({
          agents: [
            {
              composeId: "c1",
              agentName: "agent-1",
              // GH_TOKEN is resolvable by the GitHub connector
              requiredSecrets: ["GH_TOKEN", "CUSTOM_KEY"],
              requiredVariables: [],
            },
          ],
        });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    const items = await context.store.get(mergedItems$);

    // GH_TOKEN should not appear as a missing item (connector-resolvable)
    const ghToken = items.find((i) => i.name === "GH_TOKEN");
    expect(ghToken).toBeUndefined();

    // CUSTOM_KEY should appear as a missing placeholder
    const customKey = items.find((i) => i.name === "CUSTOM_KEY");
    expect(customKey).toBeDefined();
    expect(customKey!.data).toBeNull();
    expect(customKey!.agentRequired).toBeTruthy();
  });

  it("should mark configured agent-required secrets as agentRequired", async () => {
    server.use(
      http.get("http://localhost:3000/api/secrets", () => {
        return HttpResponse.json({
          secrets: [
            {
              id: "s1",
              name: "API_KEY",
              description: null,
              type: "user",
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
          ],
        });
      }),
      http.get("http://localhost:3000/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
      http.get("http://localhost:3000/api/agent/required-env", () => {
        return HttpResponse.json({
          agents: [
            {
              composeId: "c1",
              agentName: "agent-1",
              requiredSecrets: ["API_KEY"],
              requiredVariables: [],
            },
          ],
        });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    const items = await context.store.get(mergedItems$);

    const secret = items.find(
      (i) => i.kind === "secret" && i.name === "API_KEY",
    );
    expect(secret).toBeDefined();
    expect(secret!.data).not.toBeNull();
    expect(secret!.agentRequired).toBeTruthy();
  });

  it("should mark connector-resolvable configured secret as not agentRequired even if required", async () => {
    server.use(
      http.get("http://localhost:3000/api/secrets", () => {
        return HttpResponse.json({
          secrets: [
            {
              id: "s1",
              name: "GH_TOKEN",
              description: null,
              type: "user",
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
          ],
        });
      }),
      http.get("http://localhost:3000/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
      http.get("http://localhost:3000/api/agent/required-env", () => {
        return HttpResponse.json({
          agents: [
            {
              composeId: "c1",
              agentName: "agent-1",
              requiredSecrets: ["GH_TOKEN"],
              requiredVariables: [],
            },
          ],
        });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    const items = await context.store.get(mergedItems$);

    const ghToken = items.find(
      (i) => i.kind === "secret" && i.name === "GH_TOKEN",
    );
    expect(ghToken).toBeDefined();
    expect(ghToken!.data).not.toBeNull();
    // Connector-resolvable → deletable → not agentRequired
    expect(ghToken!.agentRequired).toBeFalsy();
  });

  it("should mark configured agent-required variables as agentRequired", async () => {
    server.use(
      http.get("http://localhost:3000/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
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
      http.get("http://localhost:3000/api/agent/required-env", () => {
        return HttpResponse.json({
          agents: [
            {
              composeId: "c1",
              agentName: "agent-1",
              requiredSecrets: [],
              requiredVariables: ["MY_VAR"],
            },
          ],
        });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    const items = await context.store.get(mergedItems$);

    const variable = items.find(
      (i) => i.kind === "variable" && i.name === "MY_VAR",
    );
    expect(variable).toBeDefined();
    expect(variable!.data).not.toBeNull();
    expect(variable!.agentRequired).toBeTruthy();
  });

  it("should deduplicate required secrets from multiple agents", async () => {
    server.use(
      http.get("http://localhost:3000/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("http://localhost:3000/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
      http.get("http://localhost:3000/api/agent/required-env", () => {
        return HttpResponse.json({
          agents: [
            {
              composeId: "c1",
              agentName: "agent-1",
              requiredSecrets: ["SHARED_KEY"],
              requiredVariables: ["SHARED_VAR"],
            },
            {
              composeId: "c2",
              agentName: "agent-2",
              requiredSecrets: ["SHARED_KEY"],
              requiredVariables: ["SHARED_VAR"],
            },
          ],
        });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    const items = await context.store.get(mergedItems$);

    // SHARED_KEY and SHARED_VAR should appear only once each
    const secretItems = items.filter(
      (i) => i.kind === "secret" && i.name === "SHARED_KEY",
    );
    expect(secretItems).toHaveLength(1);

    const varItems = items.filter(
      (i) => i.kind === "variable" && i.name === "SHARED_VAR",
    );
    expect(varItems).toHaveLength(1);
  });

  it("should not include missing placeholder for already-configured items", async () => {
    server.use(
      http.get("http://localhost:3000/api/secrets", () => {
        return HttpResponse.json({
          secrets: [
            {
              id: "s1",
              name: "API_KEY",
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
              name: "MY_VAR",
              value: "val",
              description: null,
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
          ],
        });
      }),
      http.get("http://localhost:3000/api/agent/required-env", () => {
        return HttpResponse.json({
          agents: [
            {
              composeId: "c1",
              agentName: "agent-1",
              requiredSecrets: ["API_KEY"],
              requiredVariables: ["MY_VAR"],
            },
          ],
        });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    const items = await context.store.get(mergedItems$);

    // Should have exactly 2 items (both configured), no missing placeholders
    expect(items).toHaveLength(2);

    const missingItems = items.filter((i) => i.data === null);
    expect(missingItems).toHaveLength(0);
  });
});
