import { z } from "zod";

import { initContract } from "../../contracts/base";
import { buildRuntimeApiSchemaDocument } from "../schema";
import type { RuntimeApiRouteBinding } from "../routes";

const c = initContract();

function binding(id: string, path: string): RuntimeApiRouteBinding {
  const contract = c.router({
    get: {
      method: "GET",
      path,
      query: z.object({ cursor: z.string().optional() }),
      responses: {
        200: z.object({ ok: z.boolean() }),
      },
    },
  });
  return { id, owner: "guest-agent", route: contract.get };
}

describe("runtime API schema namespaces", () => {
  it("publishes the strict model provider failure report contract", () => {
    const document = buildRuntimeApiSchemaDocument("2026-08-12T00:00:00.000Z");
    const route = document.routes.find(({ id }) => {
      return id === "runners.runs.modelProviderFailures";
    });

    expect(route).toMatchObject({
      method: "POST",
      owner: "mitm-addon",
      path: "/api/runners/runs/:runId/model-provider-failures",
    });
    const body = route?.request.body;
    if (!body || body.kind !== "json-schema") {
      throw new Error("Expected the model provider failure request schema");
    }
    const alternatives = body.schema.oneOf;
    if (!Array.isArray(alternatives)) {
      throw new Error("Expected failure-kind request alternatives");
    }
    expect(alternatives).toHaveLength(6);
    expect(alternatives).toContainEqual({
      additionalProperties: false,
      properties: {
        connectionSource: {
          enum: ["provider_response", "upstream_transport"],
          type: "string",
        },
        failureKind: {
          const: "connection",
          type: "string",
        },
        retryAfterSeconds: {
          exclusiveMinimum: 0,
          maximum: 300,
          type: "integer",
        },
      },
      required: ["failureKind", "connectionSource"],
      type: "object",
    });
  });

  it.each(["/api/zero/example", "/api/okou/example"] as const)(
    "publishes both branded namespaces from $sourcePath with schema parity",
    (sourcePath) => {
      const document = buildRuntimeApiSchemaDocument(
        "2026-08-12T00:00:00.000Z",
        [binding("guest.example", sourcePath)],
      );

      expect(document.supportedBrandedApiNamespacePaths).toStrictEqual([
        "/api/okou",
        "/api/zero",
      ]);
      expect(
        document.routes.map(({ id, path }) => {
          return { id, path };
        }),
      ).toStrictEqual([
        { id: "guest.example.okou", path: "/api/okou/example" },
        { id: "guest.example.zero", path: "/api/zero/example" },
      ]);

      const [okou, zero] = document.routes;
      if (!okou || !zero) {
        throw new Error("Expected both runtime API namespace routes");
      }
      expect({ ...okou, id: zero.id, path: zero.path }).toStrictEqual(zero);
    },
  );

  it("keeps neutral runtime routes single", () => {
    const document = buildRuntimeApiSchemaDocument("2026-08-12T00:00:00.000Z", [
      binding("guest.example", "/api/webhooks/agent/example"),
    ]);

    expect(document.routes).toHaveLength(1);
    expect(document.routes[0]).toMatchObject({
      id: "guest.example",
      path: "/api/webhooks/agent/example",
    });
  });

  it("rejects duplicate ids and duplicate method/path registrations", () => {
    expect(() => {
      buildRuntimeApiSchemaDocument("2026-08-12T00:00:00.000Z", [
        binding("guest.example", "/api/webhooks/agent/one"),
        binding("guest.example", "/api/webhooks/agent/two"),
      ]);
    }).toThrow("Duplicate runtime API route id: guest.example");

    expect(() => {
      buildRuntimeApiSchemaDocument("2026-08-12T00:00:00.000Z", [
        binding("guest.one", "/api/webhooks/agent/example"),
        binding("guest.two", "/api/webhooks/agent/example"),
      ]);
    }).toThrow(
      "Duplicate runtime API route registration: GET /api/webhooks/agent/example",
    );
  });
});
