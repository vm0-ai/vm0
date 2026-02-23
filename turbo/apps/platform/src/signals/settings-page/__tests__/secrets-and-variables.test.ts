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
});
