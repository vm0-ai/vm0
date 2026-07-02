import {
  compareRuntimeApiSchemas,
  type RuntimeApiCompatFinding,
} from "../compat";
import {
  type JsonObject,
  runtimeApiSchemaFormatVersion,
  type RuntimeApiSchemaDocument,
} from "../schema";

function documentWithBody(bodySchema: JsonObject): RuntimeApiSchemaDocument {
  return {
    schemaFormatVersion: runtimeApiSchemaFormatVersion,
    packageName: "@vm0/api-contracts",
    packageVersion: "0.0.0",
    generatedAt: "2026-07-02T00:00:00.000Z",
    routes: [
      {
        id: "webhooks.agent.example",
        owner: "guest-agent",
        method: "POST",
        path: "/api/webhooks/agent/example",
        request: {
          body: {
            kind: "json-schema",
            schema: bodySchema,
          },
        },
        responses: {
          "200": {
            kind: "json-schema",
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
              },
              required: ["ok"],
            },
          },
        },
      },
    ],
  };
}

function objectSchema(
  properties: Record<string, JsonObject>,
  required: readonly string[],
): JsonObject {
  return {
    type: "object",
    properties,
    required: [...required],
  };
}

function findingKinds(
  findings: readonly RuntimeApiCompatFinding[],
): readonly string[] {
  return findings.map((finding) => {
    return finding.kind;
  });
}

describe("runtime API compatibility diff", () => {
  it("allows required request fields to become optional", () => {
    const online = documentWithBody(
      objectSchema({ a: { type: "string" } }, ["a"]),
    );
    const current = documentWithBody(
      objectSchema({ a: { type: "string" } }, []),
    );

    expect(compareRuntimeApiSchemas(online, current)).toEqual([]);
  });

  it("allows optional request fields to be removed", () => {
    const online = documentWithBody(
      objectSchema({ a: { type: "string" } }, []),
    );
    const current = documentWithBody(objectSchema({}, []));

    expect(compareRuntimeApiSchemas(online, current)).toEqual([]);
  });

  it("rejects required request field removal", () => {
    const online = documentWithBody(
      objectSchema({ a: { type: "string" } }, ["a"]),
    );
    const current = documentWithBody(objectSchema({}, []));

    expect(findingKinds(compareRuntimeApiSchemas(online, current))).toContain(
      "request-required-field-removed",
    );
  });

  it("rejects adding a required request field", () => {
    const online = documentWithBody(objectSchema({}, []));
    const current = documentWithBody(
      objectSchema({ a: { type: "string" } }, ["a"]),
    );

    expect(findingKinds(compareRuntimeApiSchemas(online, current))).toContain(
      "request-required-field-added",
    );
  });

  it("rejects removing a required response field", () => {
    const online = documentWithBody(objectSchema({}, []));
    const route = online.routes[0];
    if (!route) {
      throw new Error("missing test route");
    }

    const current: RuntimeApiSchemaDocument = {
      ...online,
      routes: [
        {
          ...route,
          responses: {
            "200": {
              kind: "json-schema" as const,
              schema: {
                type: "object",
                properties: {},
                required: [],
              },
            },
          },
        },
      ],
    };

    expect(findingKinds(compareRuntimeApiSchemas(online, current))).toContain(
      "response-required-field-removed",
    );
  });

  it("allows adding a required response field", () => {
    const online = documentWithBody(objectSchema({}, []));
    const route = online.routes[0];
    if (!route) {
      throw new Error("missing test route");
    }

    const current: RuntimeApiSchemaDocument = {
      ...online,
      routes: [
        {
          ...route,
          responses: {
            "200": {
              kind: "json-schema",
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  id: { type: "string" },
                },
                required: ["ok", "id"],
              },
            },
          },
        },
      ],
    };

    expect(compareRuntimeApiSchemas(online, current)).toEqual([]);
  });
});
