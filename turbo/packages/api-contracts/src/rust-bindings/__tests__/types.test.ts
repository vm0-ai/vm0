import { z } from "zod";
import {
  normalizeTypeBindings,
  renderRustTypes,
  type NormalizedTypeBinding,
} from "../generate";
import { type RustTypeBinding, rustTypeBindings } from "../types";
import {
  artifactEntrySchema,
  storageEntrySchema,
  storageManifestSchema,
} from "../../contracts/runners";

const expectedBindings = [
  {
    rustModulePath: ["runners", "storage"],
    rustTypeName: "ArtifactEntry",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "storage"],
    rustTypeName: "StorageEntry",
    direction: "response",
  },
  {
    rustModulePath: ["runners", "storage"],
    rustTypeName: "StorageManifest",
    direction: "response",
  },
  {
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustTypeName: "Request",
    direction: "request",
  },
  {
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustTypeName: "Response",
    direction: "response",
  },
  {
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustTypeName: "Request",
    direction: "request",
  },
  {
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustTypeName: "Response",
    direction: "response",
  },
] as const;

function validBinding(
  overrides: Partial<RustTypeBinding> = {},
): RustTypeBinding {
  return {
    schema: z.object({
      runId: z.string(),
    }),
    rustModulePath: ["webhooks", "agent", "example"],
    rustTypeName: "Request",
    direction: "request",
    ...overrides,
  };
}

function summarizeBinding(binding: NormalizedTypeBinding) {
  return {
    rustModulePath: [...binding.rustModulePath],
    rustTypeName: binding.rustTypeName,
    direction: binding.direction,
  };
}

describe("Rust type bindings", () => {
  it("contains exactly the supported Rust DTO set", () => {
    const actualBindings = normalizeTypeBindings(rustTypeBindings).map(
      (binding) => {
        return summarizeBinding(binding);
      },
    );

    expect(actualBindings).toEqual(
      [...expectedBindings].sort((left, right) => {
        return [...left.rustModulePath, left.rustTypeName]
          .join("::")
          .localeCompare(
            [...right.rustModulePath, right.rustTypeName].join("::"),
          );
      }),
    );
  });

  it("renders deterministic Rust DTOs for the supported registry", () => {
    const firstRender = renderRustTypes(rustTypeBindings);
    const secondRender = renderRustTypes(rustTypeBindings);

    expect(secondRender).toBe(firstRender);
    expect(firstRender).toContain("pub mod webhooks {");
    expect(firstRender).toContain("pub mod prepare {");
    expect(firstRender).toContain("pub struct Request {");
    expect(firstRender).toContain("pub struct Response {");
    expect(firstRender).toContain("pub files: Vec<RequestFile>,");
    expect(firstRender).toContain("pub uploads: Option<ResponseUploads>,");
    expect(firstRender).toContain("pub struct StorageManifest {");
    expect(firstRender).toContain("pub storages: Vec<StorageEntry>,");
    expect(firstRender).toContain("pub artifacts: Vec<ArtifactEntry>,");
  });

  it("keeps storage manifest field overrides aligned with entry schemas", () => {
    const manifestSchema = z.toJSONSchema(storageManifestSchema);
    const storageSchema = { ...z.toJSONSchema(storageEntrySchema) };
    const artifactSchema = { ...z.toJSONSchema(artifactEntrySchema) };
    delete storageSchema.$schema;
    delete artifactSchema.$schema;

    expect(manifestSchema).toMatchObject({
      required: ["storages", "artifacts"],
      properties: {
        storages: {
          type: "array",
          items: storageSchema,
        },
        artifacts: {
          type: "array",
          items: artifactSchema,
        },
      },
    });
  });

  it("renders common JSON schema shapes", () => {
    const rendered = renderRustTypes([
      validBinding({
        schema: z.object({
          mode: z.enum(["running", "stopping"]),
          optionalValue: z.string().optional(),
          nullableValue: z.string().nullable(),
          labels: z.record(z.string(), z.string()),
          items: z.array(
            z.object({
              someValue: z.number().int().nonnegative(),
            }),
          ),
          ok: z.literal(true),
        }),
      }),
    ]);

    expect(rendered).toContain("pub enum RequestMode {");
    expect(rendered).toContain('#[serde(rename = "running")]');
    expect(rendered).toContain("Running,");
    expect(rendered).toContain("pub optional_value: Option<String>,");
    expect(rendered).toContain("pub nullable_value: Option<String>,");
    expect(rendered).toContain(
      "pub labels: std::collections::BTreeMap<String, String>,",
    );
    expect(rendered).toContain("pub items: Vec<RequestItem>,");
    expect(rendered).toContain("pub some_value: u64,");
    expect(rendered).toContain("pub ok: bool,");
  });

  it("renders optional nullable fields without nested options", () => {
    const rendered = renderRustTypes([
      validBinding({
        schema: z.object({
          maybe: z.string().nullable().optional(),
        }),
      }),
    ]);

    expect(rendered).toContain("pub maybe: Option<String>,");
    expect(rendered).not.toContain("Option<Option<String>>");
  });

  it("uses explicit field type overrides", () => {
    const rendered = renderRustTypes([
      validBinding({
        schema: z.object({
          storageType: z.enum(["volume", "artifact"]),
        }),
        fieldTypeOverrides: {
          storageType: "String",
        },
      }),
    ]);

    expect(rendered).toContain("pub storage_type: String,");
    expect(rendered).not.toContain("pub enum RequestStorageType");
  });

  it("renames Rust keyword fields", () => {
    const rendered = renderRustTypes([
      validBinding({
        schema: z.object({
          type: z.string(),
          self: z.boolean(),
        }),
      }),
    ]);

    expect(rendered).toContain('#[serde(rename = "type")]');
    expect(rendered).toContain("pub type_: String,");
    expect(rendered).toContain('#[serde(rename = "self")]');
    expect(rendered).toContain("pub self_: bool,");
  });

  it("renames Rust keyword enum variants", () => {
    const rendered = renderRustTypes([
      validBinding({
        schema: z.object({
          mode: z.enum(["self", "ready"]),
        }),
      }),
    ]);

    expect(rendered).toContain('#[serde(rename = "self")]');
    expect(rendered).toContain("Self_,");
    expect(rendered).toContain("Ready,");
  });

  it("fails clearly for unsupported unions", () => {
    expect(() => {
      renderRustTypes([
        validBinding({
          schema: z.union([
            z.object({ a: z.string() }),
            z.object({ b: z.string() }),
          ]),
        }),
      ]);
    }).toThrow("unsupported anyOf schema");
  });

  it("fails clearly for passthrough object schemas", () => {
    expect(() => {
      renderRustTypes([
        validBinding({
          schema: z.object({ type: z.string() }).passthrough(),
        }),
      ]);
    }).toThrow("unsupported untyped additionalProperties");
  });

  it("fails clearly when a Rust type name is invalid", () => {
    expect(() => {
      normalizeTypeBindings([
        validBinding({
          rustTypeName: "bad_type",
        }),
      ]);
    }).toThrow("invalid Rust type name");
  });

  it("fails clearly when wire fields collide as Rust field names", () => {
    expect(() => {
      renderRustTypes([
        validBinding({
          schema: z.object({
            apiURL: z.string(),
            apiUrl: z.string(),
          }),
        }),
      ]);
    }).toThrow("maps both apiURL and apiUrl to Rust field api_url");
  });

  it("fails clearly when enum values collide as Rust variant names", () => {
    expect(() => {
      renderRustTypes([
        validBinding({
          schema: z.object({
            mode: z.enum(["foo-bar", "foo_bar"]),
          }),
        }),
      ]);
    }).toThrow("duplicate Rust enum variant: FooBar");
  });

  it("fails clearly when nested fields collide as Rust type names", () => {
    expect(() => {
      renderRustTypes([
        validBinding({
          schema: z.object({
            user: z.object({ id: z.string() }),
            users: z.array(z.object({ name: z.string() })),
          }),
        }),
      ]);
    }).toThrow("duplicate Rust type name: RequestUser");
  });

  it("fails clearly when bindings and nested fields collide as Rust type names", () => {
    expect(() => {
      renderRustTypes([
        validBinding({
          rustTypeName: "RequestFile",
          schema: z.object({
            path: z.string(),
          }),
        }),
        validBinding({
          rustTypeName: "Request",
          schema: z.object({
            files: z.array(z.object({ path: z.string() })),
          }),
        }),
      ]);
    }).toThrow(
      "generates duplicate Rust type name RequestFile in module webhooks::agent::example",
    );
  });
});
