import {
  closeFixtureDbPool,
  createBuiltInModelsFixture,
  deleteBuiltInModelsFixture,
  seedBuiltInModelsFixture,
} from "./db.fixture";
import { testContext } from "./test-helpers";

interface ApiRootResponse {
  message: string;
  models: string[];
}

const builtInModelsFixture = createBuiltInModelsFixture();
const context = testContext();

function assertApiRootResponse(
  value: unknown,
): asserts value is ApiRootResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Expected API root response to be an object");
  }

  if (!("message" in value) || typeof value.message !== "string") {
    throw new Error("Expected API root response message");
  }

  if (
    !("models" in value) ||
    !Array.isArray(value.models) ||
    !value.models.every((model) => {
      return typeof model === "string";
    })
  ) {
    throw new Error("Expected API root response models");
  }
}

describe("api app", () => {
  beforeAll(async () => {
    await seedBuiltInModelsFixture(builtInModelsFixture);
  });

  afterAll(async () => {
    await deleteBuiltInModelsFixture(builtInModelsFixture);
    await closeFixtureDbPool();
  });

  it("lists built-in models without exposing vendors", async () => {
    const response = await context.app.request("/");
    const payload: unknown = await response.json();

    expect(response.status).toBe(200);
    assertApiRootResponse(payload);
    expect(payload.message).toBe("Hello Hono!");
    expect(payload.models).toEqual(
      expect.arrayContaining(builtInModelsFixture.models),
    );
    expect(JSON.stringify(payload)).not.toContain(builtInModelsFixture.vendor);
  });

  it("serves a lightweight health check", async () => {
    const response = await context.app.request("/health");
    const payload: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ status: "ok" });
  });
});
