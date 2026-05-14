import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  type RustStringConstantBinding,
  rustStringConstantBindings,
} from "./constants";
import { type RustRouteBinding, rustRouteBindings } from "./routes";
import { type RustTypeBinding, rustTypeBindings } from "./types";

const generatedRoutesPath = fileURLToPath(
  new URL(
    "../../../../../crates/api-contracts/src/generated/routes.rs",
    import.meta.url,
  ),
);
const generatedTypesPath = fileURLToPath(
  new URL(
    "../../../../../crates/api-contracts/src/generated/types.rs",
    import.meta.url,
  ),
);
const generatedModelProvidersPath = fileURLToPath(
  new URL(
    "../../../../../crates/api-contracts/src/generated/model_providers.rs",
    import.meta.url,
  ),
);
const generatedModPath = fileURLToPath(
  new URL(
    "../../../../../crates/api-contracts/src/generated/mod.rs",
    import.meta.url,
  ),
);

const httpMethods = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

export type HttpMethod = (typeof httpMethods)[number];
export type RustMethodVariant =
  | "Get"
  | "Post"
  | "Put"
  | "Patch"
  | "Delete"
  | "Head"
  | "Options";

export interface NormalizedRouteBinding {
  readonly method: HttpMethod;
  readonly path: string;
  readonly pathParams: readonly PathParamBinding[];
  readonly rustMethodVariant: RustMethodVariant;
  readonly rustModulePath: readonly string[];
  readonly rustConstName: string;
}

interface PathParamBinding {
  readonly routeName: string;
  readonly rustName: string;
}

interface ModuleNode {
  readonly routes: NormalizedRouteBinding[];
  readonly children: Map<string, ModuleNode>;
}

export interface NormalizedTypeBinding {
  readonly schema: JsonObject;
  readonly direction: "request" | "response";
  readonly rustModulePath: readonly string[];
  readonly rustTypeName: string;
  readonly fieldTypeOverrides: Readonly<Record<string, string>>;
}

export interface NormalizedStringConstantBinding {
  readonly rustModulePath: readonly string[];
  readonly rustConstName: string;
  readonly value: string;
}

interface TypeModuleNode {
  readonly declarations: RustDeclaration[];
  readonly declarationNames: Set<string>;
  readonly children: Map<string, TypeModuleNode>;
}

interface ConstModuleNode {
  readonly constants: NormalizedStringConstantBinding[];
  readonly children: Map<string, ConstModuleNode>;
}

interface RenderTypeContext {
  readonly label: string;
  readonly fieldTypeOverrides: Readonly<Record<string, string>>;
  readonly declarations: RustDeclaration[];
  readonly declarationNames: Set<string>;
}

interface RustDeclaration {
  readonly name: string;
  readonly lines: string[];
}

type JsonObject = Record<string, unknown>;

const rustModuleSegmentPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const rustConstNamePattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const rustTypeNamePattern = /^[A-Z][A-Za-z0-9]*$/;
const routePathParamPattern = /^[A-Za-z][A-Za-z0-9_]*$/;
const rustKeywords = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "become",
  "box",
  "break",
  "const",
  "continue",
  "crate",
  "do",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "final",
  "fn",
  "for",
  "gen",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "macro",
  "macro_rules",
  "match",
  "mod",
  "move",
  "mut",
  "override",
  "priv",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "try",
  "type",
  "typeof",
  "union",
  "unsized",
  "unsafe",
  "use",
  "virtual",
  "where",
  "while",
  "yield",
]);

export function normalizeRouteBindings(
  bindings: readonly RustRouteBinding[],
): readonly NormalizedRouteBinding[] {
  const seenRustNames = new Set<string>();
  const seenRoutes = new Set<string>();
  const normalized: NormalizedRouteBinding[] = [];

  for (const binding of bindings) {
    const label = routeLabel(binding);
    const method = validateHttpMethod(binding.route.method, label);
    const path = validateRoutePath(binding.route.path, label);
    const pathParams = extractPathParams(path, label);
    const rustModulePath = validateRustModulePath(
      binding.rustModulePath,
      label,
    );
    const rustConstName = validateRustConstName(binding.rustConstName, label);
    const rustName = [...rustModulePath, rustConstName].join("::");
    const routeKey = `${method} ${path}`;

    if (seenRustNames.has(rustName)) {
      throw new Error(`duplicate Rust route binding: ${rustName}`);
    }
    seenRustNames.add(rustName);

    if (seenRoutes.has(routeKey)) {
      throw new Error(`duplicate route binding: ${routeKey}`);
    }
    seenRoutes.add(routeKey);

    normalized.push({
      method,
      path,
      pathParams,
      rustMethodVariant: toRustMethodVariant(method),
      rustModulePath,
      rustConstName,
    });
  }

  return [...normalized].sort(compareRouteBindings);
}

export function renderRustRoutes(
  bindings: readonly RustRouteBinding[],
): string {
  const routes = normalizeRouteBindings(bindings);
  const root = buildRouteTree(routes);
  const lines = [
    "// @generated by @vm0/api-contracts.",
    "// Do not edit by hand.",
    "// Regenerate with: cd turbo && pnpm -F @vm0/api-contracts generate:rust",
    "",
    ...renderModuleNode(root, ""),
  ];

  return `${lines.join("\n")}\n`;
}

export async function generateRustRoutesFile(
  outputPath = generatedRoutesPath,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderRustRoutes(rustRouteBindings));
}

export function normalizeTypeBindings(
  bindings: readonly RustTypeBinding[],
): readonly NormalizedTypeBinding[] {
  const seenRustNames = new Set<string>();
  const normalized: NormalizedTypeBinding[] = [];

  for (const binding of bindings) {
    const label = typeLabel(binding);
    const rustModulePath = validateRustModulePath(
      binding.rustModulePath,
      label,
    );
    const rustTypeName = validateRustTypeName(binding.rustTypeName, label);
    const rustName = [...rustModulePath, rustTypeName].join("::");

    if (seenRustNames.has(rustName)) {
      throw new Error(`duplicate Rust type binding: ${rustName}`);
    }
    seenRustNames.add(rustName);

    normalized.push({
      schema: validateJsonSchema(z.toJSONSchema(binding.schema), label),
      direction: binding.direction,
      rustModulePath,
      rustTypeName,
      fieldTypeOverrides: binding.fieldTypeOverrides ?? {},
    });
  }

  return [...normalized].sort(compareTypeBindings);
}

export function renderRustTypes(bindings: readonly RustTypeBinding[]): string {
  const types = normalizeTypeBindings(bindings);
  const root = buildTypeTree(types);
  const lines = [
    "// @generated by @vm0/api-contracts.",
    "// Do not edit by hand.",
    "// Regenerate with: cd turbo && pnpm -F @vm0/api-contracts generate:rust",
    "",
    ...renderTypeModuleNode(root, ""),
  ];

  return `${lines.join("\n")}\n`;
}

export async function generateRustTypesFile(
  outputPath = generatedTypesPath,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderRustTypes(rustTypeBindings));
}

export function normalizeStringConstantBindings(
  bindings: readonly RustStringConstantBinding[],
): readonly NormalizedStringConstantBinding[] {
  const seenRustNames = new Set<string>();
  const normalized: NormalizedStringConstantBinding[] = [];

  for (const binding of bindings) {
    const label = stringConstantLabel(binding);
    const rustModulePath = validateRustModulePath(
      binding.rustModulePath,
      label,
    );
    const rustConstName = validateRustConstName(binding.rustConstName, label);
    const rustName = [...rustModulePath, rustConstName].join("::");

    if (seenRustNames.has(rustName)) {
      throw new Error(`duplicate Rust string constant binding: ${rustName}`);
    }
    seenRustNames.add(rustName);

    normalized.push({
      rustModulePath,
      rustConstName,
      value: validateStringConstantValue(binding.value, label),
    });
  }

  return [...normalized].sort(compareStringConstantBindings);
}

export function renderRustStringConstants(
  bindings: readonly RustStringConstantBinding[],
): string {
  const constants = normalizeStringConstantBindings(bindings);
  const root = buildConstTree(constants);
  const lines = [
    "// @generated by @vm0/api-contracts.",
    "// Do not edit by hand.",
    "// Regenerate with: cd turbo && pnpm -F @vm0/api-contracts generate:rust",
    "",
    "// These values are fake marker bytes used for firewall substitution.",
    "// They are not real secrets.",
    "",
    ...renderConstModuleNode(root, ""),
  ];

  return `${lines.join("\n")}\n`;
}

export async function generateRustModelProvidersFile(
  outputPath = generatedModelProvidersPath,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    renderRustStringConstants(rustStringConstantBindings),
  );
}

export function renderGeneratedMod(): string {
  return [
    "pub mod model_providers;",
    "pub mod routes;",
    "pub mod types;",
    "",
  ].join("\n");
}

export async function generateRustGeneratedModFile(
  outputPath = generatedModPath,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderGeneratedMod());
}

export async function generateRustBindings(): Promise<void> {
  await generateRustRoutesFile();
  await generateRustTypesFile();
  await generateRustModelProvidersFile();
  await generateRustGeneratedModFile();
}

function routeLabel(binding: RustRouteBinding): string {
  const rustName = [...binding.rustModulePath, binding.rustConstName].join(
    "::",
  );
  return rustName.length > 0 ? rustName : "<unnamed route binding>";
}

function typeLabel(binding: RustTypeBinding): string {
  const rustName = [...binding.rustModulePath, binding.rustTypeName].join("::");
  return rustName.length > 0 ? rustName : "<unnamed type binding>";
}

function stringConstantLabel(binding: RustStringConstantBinding): string {
  const rustName = [...binding.rustModulePath, binding.rustConstName].join(
    "::",
  );
  return rustName.length > 0 ? rustName : "<unnamed string constant binding>";
}

function validateHttpMethod(value: unknown, label: string): HttpMethod {
  if (typeof value !== "string") {
    throw new Error(`${label} is missing a string HTTP method`);
  }

  if (!isHttpMethod(value)) {
    throw new Error(`${label} uses unsupported HTTP method: ${value}`);
  }

  return value;
}

function validateRoutePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is missing a string route path`);
  }

  if (!value.startsWith("/")) {
    throw new Error(`${label} route path must start with '/': ${value}`);
  }

  return value;
}

function extractPathParams(
  path: string,
  label: string,
): readonly PathParamBinding[] {
  const seenRouteNames = new Set<string>();
  const seenRustNames = new Set<string>();
  const params: PathParamBinding[] = [];

  for (const segment of path.split("/")) {
    if (!segment.includes(":")) {
      continue;
    }

    if (!segment.startsWith(":")) {
      throw new Error(`${label} uses unsupported route param segment: ${path}`);
    }

    const routeName = segment.slice(1);
    if (!routePathParamPattern.test(routeName)) {
      throw new Error(`${label} has invalid route param name: ${routeName}`);
    }

    const rustName = toRustParamName(routeName);
    if (seenRouteNames.has(routeName)) {
      throw new Error(`${label} has duplicate route param: ${routeName}`);
    }
    if (seenRustNames.has(rustName)) {
      throw new Error(`${label} has duplicate Rust route param: ${rustName}`);
    }

    seenRouteNames.add(routeName);
    seenRustNames.add(rustName);
    params.push({ routeName, rustName });
  }

  return params;
}

function toRustParamName(routeName: string): string {
  const snake = routeName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

  return rustKeywords.has(snake) ? `${snake}_` : snake;
}

function validateRustModulePath(
  segments: readonly string[],
  label: string,
): readonly string[] {
  if (segments.length === 0) {
    throw new Error(`${label} must declare at least one Rust module segment`);
  }

  return segments.map((segment) => {
    if (!rustModuleSegmentPattern.test(segment)) {
      throw new Error(`${label} has invalid Rust module segment: ${segment}`);
    }

    return segment;
  });
}

function validateRustConstName(value: string, label: string): string {
  if (!rustConstNamePattern.test(value)) {
    throw new Error(`${label} has invalid Rust const name: ${value}`);
  }

  return value;
}

function validateRustTypeName(value: string, label: string): string {
  if (!rustTypeNamePattern.test(value)) {
    throw new Error(`${label} has invalid Rust type name: ${value}`);
  }

  return value;
}

function validateStringConstantValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is missing a string constant value`);
  }

  return value;
}

function isHttpMethod(value: string): value is HttpMethod {
  return httpMethods.some((method) => {
    return method === value;
  });
}

function toRustMethodVariant(method: HttpMethod): RustMethodVariant {
  switch (method) {
    case "GET":
      return "Get";
    case "POST":
      return "Post";
    case "PUT":
      return "Put";
    case "PATCH":
      return "Patch";
    case "DELETE":
      return "Delete";
    case "HEAD":
      return "Head";
    case "OPTIONS":
      return "Options";
  }
}

function compareRouteBindings(
  left: NormalizedRouteBinding,
  right: NormalizedRouteBinding,
): number {
  return compareAscii(rustRouteName(left), rustRouteName(right));
}

function rustRouteName(binding: NormalizedRouteBinding): string {
  return [...binding.rustModulePath, binding.rustConstName].join("::");
}

function buildRouteTree(routes: readonly NormalizedRouteBinding[]): ModuleNode {
  const root = createModuleNode();

  for (const route of routes) {
    let node = root;

    for (const segment of route.rustModulePath) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = createModuleNode();
        node.children.set(segment, child);
      }
      node = child;
    }

    node.routes.push(route);
  }

  return root;
}

function createModuleNode(): ModuleNode {
  return {
    routes: [],
    children: new Map(),
  };
}

function compareTypeBindings(
  left: NormalizedTypeBinding,
  right: NormalizedTypeBinding,
): number {
  return compareAscii(rustTypeName(left), rustTypeName(right));
}

function rustTypeName(binding: NormalizedTypeBinding): string {
  return [...binding.rustModulePath, binding.rustTypeName].join("::");
}

function compareStringConstantBindings(
  left: NormalizedStringConstantBinding,
  right: NormalizedStringConstantBinding,
): number {
  return compareAscii(
    rustStringConstantName(left),
    rustStringConstantName(right),
  );
}

function rustStringConstantName(
  binding: NormalizedStringConstantBinding,
): string {
  return [...binding.rustModulePath, binding.rustConstName].join("::");
}

function buildTypeTree(
  types: readonly NormalizedTypeBinding[],
): TypeModuleNode {
  const root = createTypeModuleNode();

  for (const type of types) {
    let node = root;

    for (const segment of type.rustModulePath) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = createTypeModuleNode();
        node.children.set(segment, child);
      }
      node = child;
    }

    for (const declaration of renderTypeBinding(type)) {
      if (node.declarationNames.has(declaration.name)) {
        throw new Error(
          `${rustTypeName(type)} generates duplicate Rust type name ${declaration.name} in module ${type.rustModulePath.join("::")}`,
        );
      }
      node.declarationNames.add(declaration.name);
      node.declarations.push(declaration);
    }
  }

  return root;
}

function createTypeModuleNode(): TypeModuleNode {
  return {
    declarations: [],
    declarationNames: new Set(),
    children: new Map(),
  };
}

function buildConstTree(
  constants: readonly NormalizedStringConstantBinding[],
): ConstModuleNode {
  const root = createConstModuleNode();

  for (const constant of constants) {
    let node = root;

    for (const segment of constant.rustModulePath) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = createConstModuleNode();
        node.children.set(segment, child);
      }
      node = child;
    }

    node.constants.push(constant);
  }

  return root;
}

function createConstModuleNode(): ConstModuleNode {
  return {
    constants: [],
    children: new Map(),
  };
}

function renderConstModuleNode(
  node: ConstModuleNode,
  indent: string,
): string[] {
  const lines: string[] = [];
  const constants = [...node.constants].sort(compareStringConstantBindings);
  const children = [...node.children.entries()].sort(
    ([leftName], [rightName]) => {
      return compareAscii(leftName, rightName);
    },
  );

  for (const constant of constants) {
    appendBlankLineIfNeeded(lines);
    lines.push(...renderStringConstant(constant, indent));
  }

  for (const [moduleName, child] of children) {
    appendBlankLineIfNeeded(lines);
    lines.push(`${indent}pub mod ${moduleName} {`);
    lines.push(...renderConstModuleNode(child, `${indent}    `));
    lines.push(`${indent}}`);
  }

  return lines;
}

function renderStringConstant(
  constant: NormalizedStringConstantBinding,
  indent: string,
): string[] {
  const literal = rustStringLiteral(constant.value);
  const singleLine = `${indent}pub const ${constant.rustConstName}: &str = ${literal};`;
  if (singleLine.length <= 100) {
    return [singleLine];
  }

  return [
    `${indent}pub const ${constant.rustConstName}: &str =`,
    `${indent}    ${literal};`,
  ];
}

function renderTypeModuleNode(node: TypeModuleNode, indent: string): string[] {
  const lines: string[] = [];
  const children = [...node.children.entries()].sort(
    ([leftName], [rightName]) => {
      return compareAscii(leftName, rightName);
    },
  );

  for (const declaration of node.declarations) {
    appendBlankLineIfNeeded(lines);
    lines.push(
      ...declaration.lines.map((line) => {
        return line.length === 0 ? "" : `${indent}${line}`;
      }),
    );
  }

  for (const [moduleName, child] of children) {
    appendBlankLineIfNeeded(lines);
    lines.push(`${indent}pub mod ${moduleName} {`);
    lines.push(...renderTypeModuleNode(child, `${indent}    `));
    lines.push(`${indent}}`);
  }

  return lines;
}

function renderTypeBinding(
  binding: NormalizedTypeBinding,
): readonly RustDeclaration[] {
  const declarations: RustDeclaration[] = [];
  const context: RenderTypeContext = {
    label: rustTypeName(binding),
    fieldTypeOverrides: binding.fieldTypeOverrides,
    declarations,
    declarationNames: new Set(),
  };
  const rootType = rustTypeForSchema(
    binding.schema,
    binding.rustTypeName,
    context,
  );
  if (rootType !== binding.rustTypeName) {
    throw new Error(
      `${context.label} must render as ${binding.rustTypeName}, got ${rootType}`,
    );
  }

  return declarations;
}

function rustTypeForSchema(
  schema: JsonObject,
  typeName: string,
  context: RenderTypeContext,
): string {
  const nullable = unwrapNullable(schema, context.label);
  if (nullable !== null) {
    return `Option<${rustTypeForSchema(nullable, typeName, context)}>`;
  }

  const enumValues = getStringArray(schema.enum);
  if (enumValues !== null) {
    return renderStringEnum(enumValues, typeName, context);
  }

  if ("const" in schema) {
    return rustTypeForConst(schema, context.label);
  }

  const type = getJsonSchemaType(schema, context.label);
  switch (type) {
    case "object":
      return rustTypeForObject(schema, typeName, context);
    case "array":
      return `Vec<${rustTypeForArrayItem(schema, typeName, context)}>`;
    case "string":
      return "String";
    case "boolean":
      return "bool";
    case "integer":
      return rustIntegerType(schema);
    case "number":
      return "f64";
    case "null":
      throw new Error(`${context.label} uses unsupported bare null schema`);
    default:
      throw new Error(
        `${context.label} uses unsupported JSON schema type: ${type}`,
      );
  }
}

function rustTypeForObject(
  schema: JsonObject,
  typeName: string,
  context: RenderTypeContext,
): string {
  const properties = getOptionalObject(schema.properties);
  const additionalProperties = schema.additionalProperties;

  if (properties === null || Object.keys(properties).length === 0) {
    if (isJsonObject(additionalProperties)) {
      if (Object.keys(additionalProperties).length === 0) {
        throw new Error(
          `${context.label}.${typeName} uses unsupported untyped additionalProperties`,
        );
      }
      return `std::collections::BTreeMap<String, ${rustTypeForSchema(
        additionalProperties,
        `${typeName}Value`,
        context,
      )}>`;
    }
  }

  if (
    isJsonObject(additionalProperties) &&
    Object.keys(additionalProperties).length > 0
  ) {
    throw new Error(
      `${context.label}.${typeName} mixes fixed properties with additionalProperties`,
    );
  }
  if (additionalProperties === true) {
    throw new Error(
      `${context.label}.${typeName} uses unsupported passthrough object schema`,
    );
  }
  if (
    isJsonObject(additionalProperties) &&
    Object.keys(additionalProperties).length === 0
  ) {
    throw new Error(
      `${context.label}.${typeName} uses unsupported untyped additionalProperties`,
    );
  }

  return renderStruct(properties ?? {}, schema.required, typeName, context);
}

function rustTypeForArrayItem(
  schema: JsonObject,
  typeName: string,
  context: RenderTypeContext,
): string {
  if (!isJsonObject(schema.items)) {
    throw new Error(`${context.label}.${typeName} array is missing items`);
  }

  return rustTypeForSchema(schema.items, typeName, context);
}

function rustTypeForConst(schema: JsonObject, label: string): string {
  const value = schema.const;
  switch (typeof value) {
    case "string":
      return "String";
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(value) ? rustIntegerType(schema) : "f64";
    default:
      throw new Error(`${label} uses unsupported const value`);
  }
}

function rustIntegerType(schema: JsonObject): "i64" | "u64" {
  return typeof schema.minimum === "number" && schema.minimum >= 0
    ? "u64"
    : "i64";
}

function renderStruct(
  properties: JsonObject,
  requiredValue: unknown,
  typeName: string,
  context: RenderTypeContext,
): string {
  if (context.declarationNames.has(typeName)) {
    throw new Error(
      `${context.label} has duplicate Rust type name: ${typeName}`,
    );
  }
  context.declarationNames.add(typeName);

  const required = new Set(getStringArray(requiredValue) ?? []);
  const seenRustFields = new Map<string, string>();
  const lines = [
    "#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]",
    '#[serde(rename_all = "camelCase")]',
    `pub struct ${typeName} {`,
  ];

  for (const [wireName, rawPropertySchema] of Object.entries(properties)) {
    if (!isJsonObject(rawPropertySchema)) {
      throw new Error(
        `${context.label}.${typeName}.${wireName} is not an object schema`,
      );
    }

    const rustName = toRustFieldName(wireName);
    const previousWireName = seenRustFields.get(rustName);
    if (previousWireName !== undefined) {
      throw new Error(
        `${context.label}.${typeName} maps both ${previousWireName} and ${wireName} to Rust field ${rustName}`,
      );
    }
    seenRustFields.set(rustName, wireName);

    const optional = !required.has(wireName);
    const override = context.fieldTypeOverrides[wireName];
    const rawType =
      override ??
      rustTypeForSchema(
        rawPropertySchema,
        nestedTypeNameForField(typeName, wireName, rawPropertySchema),
        context,
      );
    const rustType =
      optional && !isOptionType(rawType) ? `Option<${rawType}>` : rawType;
    const attributes = serdeFieldAttributes({
      wireName,
      rustName,
      optional,
    });

    for (const attribute of attributes) {
      lines.push(`    ${attribute}`);
    }
    lines.push(`    pub ${rustName}: ${rustType},`);
  }

  lines.push("}");
  context.declarations.push({
    name: typeName,
    lines,
  });

  return typeName;
}

function renderStringEnum(
  values: readonly string[],
  typeName: string,
  context: RenderTypeContext,
): string {
  if (context.declarationNames.has(typeName)) {
    throw new Error(
      `${context.label} has duplicate Rust type name: ${typeName}`,
    );
  }
  context.declarationNames.add(typeName);

  const seenVariants = new Set<string>();
  const lines = [
    "#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]",
    `pub enum ${typeName} {`,
  ];

  for (const value of values) {
    const variant = toRustVariantName(value);
    if (seenVariants.has(variant)) {
      throw new Error(
        `${context.label}.${typeName} has duplicate Rust enum variant: ${variant}`,
      );
    }
    seenVariants.add(variant);
    lines.push(`    #[serde(rename = ${rustStringLiteral(value)})]`);
    lines.push(`    ${variant},`);
  }

  lines.push("}");
  context.declarations.push({
    name: typeName,
    lines,
  });

  return typeName;
}

function renderModuleNode(node: ModuleNode, indent: string): string[] {
  const lines: string[] = [];
  const routes = [...node.routes].sort(compareRouteBindings);
  const children = [...node.children.entries()].sort(
    ([leftName], [rightName]) => {
      return compareAscii(leftName, rightName);
    },
  );

  for (const route of routes) {
    const routeType = route.pathParams.length > 0 ? "RouteTemplate" : "Route";
    appendBlankLineIfNeeded(lines);
    lines.push(
      `${indent}pub const ${route.rustConstName}: crate::${routeType} = crate::${routeType} {`,
    );
    lines.push(
      `${indent}    method: crate::Method::${route.rustMethodVariant},`,
    );
    lines.push(`${indent}    path: ${rustStringLiteral(route.path)},`);
    lines.push(`${indent}};`);

    if (route.pathParams.length > 0) {
      lines.push("");
      lines.push(`${indent}#[derive(Debug, Clone, Copy)]`);
      lines.push(`${indent}pub struct Params<'a> {`);
      for (const param of route.pathParams) {
        lines.push(`${indent}    pub ${param.rustName}: &'a str,`);
      }
      lines.push(`${indent}}`);
      lines.push("");
      lines.push(`${indent}#[must_use]`);
      lines.push(`${indent}pub fn path(params: Params<'_>) -> String {`);
      lines.push(...renderParameterizedPath(route, `${indent}    `));
      lines.push(`${indent}}`);
      lines.push("");
      lines.push(`${indent}#[must_use]`);
      lines.push(
        `${indent}pub fn route(params: Params<'_>) -> crate::ResolvedRoute {`,
      );
      lines.push(
        `${indent}    crate::ResolvedRoute::new(${route.rustConstName}.method, path(params))`,
      );
      lines.push(`${indent}}`);
    }
  }

  for (const [moduleName, child] of children) {
    appendBlankLineIfNeeded(lines);
    lines.push(`${indent}pub mod ${moduleName} {`);
    lines.push(...renderModuleNode(child, `${indent}    `));
    lines.push(`${indent}}`);
  }

  return lines;
}

function renderParameterizedPath(
  route: NormalizedRouteBinding,
  indent: string,
): string[] {
  const formatPath = route.path
    .split("/")
    .map((segment) => {
      return segment.startsWith(":") ? "{}" : escapeRustFormatString(segment);
    })
    .join("/");
  const args = route.pathParams.map((param) => {
    return `crate::route::encode_path_segment(params.${param.rustName})`;
  });

  const lines = [
    `${indent}format!(`,
    `${indent}    ${rustStringLiteral(formatPath)},`,
  ];
  for (const arg of args) {
    lines.push(`${indent}    ${arg},`);
  }
  lines.push(`${indent})`);
  return lines;
}

function escapeRustFormatString(value: string): string {
  return value.replace(/\{/g, "{{").replace(/\}/g, "}}");
}

function validateJsonSchema(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} did not produce a JSON schema object`);
  }

  return value;
}

function unwrapNullable(schema: JsonObject, label: string): JsonObject | null {
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((type) => {
      return type !== "null";
    });
    if (nonNullTypes.length === 1 && schema.type.includes("null")) {
      const [nonNullType] = nonNullTypes;
      if (typeof nonNullType === "string") {
        return {
          ...schema,
          type: nonNullType,
        };
      }
    }
    throw new Error(`${label} uses unsupported nullable type array`);
  }

  const anyOf = schema.anyOf;
  if (anyOf === undefined) {
    return null;
  }
  if (!Array.isArray(anyOf)) {
    throw new Error(`${label} uses malformed anyOf`);
  }

  const nonNullSchemas = anyOf.filter((entry): entry is JsonObject => {
    return isJsonObject(entry) && entry.type !== "null";
  });
  const nullSchemas = anyOf.filter((entry) => {
    return isJsonObject(entry) && entry.type === "null";
  });

  if (nonNullSchemas.length === 1 && nullSchemas.length === 1) {
    const nonNullSchema = nonNullSchemas[0];
    if (nonNullSchema !== undefined) {
      return nonNullSchema;
    }
  }

  throw new Error(`${label} uses unsupported anyOf schema`);
}

function getJsonSchemaType(schema: JsonObject, label: string): string {
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((type) => {
      return type !== "null";
    });
    if (nonNullTypes.length === 1 && schema.type.includes("null")) {
      return String(nonNullTypes[0]);
    }
    throw new Error(`${label} uses unsupported type array`);
  }

  if (typeof schema.type !== "string") {
    throw new Error(`${label} is missing a supported JSON schema type`);
  }

  return schema.type;
}

function getOptionalObject(value: unknown): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

function getStringArray(value: unknown): readonly string[] | null {
  if (
    Array.isArray(value) &&
    value.every((entry) => {
      return typeof entry === "string";
    })
  ) {
    return value;
  }

  return null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionType(value: string): boolean {
  return value.startsWith("Option<");
}

function serdeFieldAttributes({
  wireName,
  rustName,
  optional,
}: {
  readonly wireName: string;
  readonly rustName: string;
  readonly optional: boolean;
}): string[] {
  const entries: string[] = [];
  if (toCamelCase(rustName) !== wireName) {
    entries.push(`rename = ${rustStringLiteral(wireName)}`);
  }
  if (optional) {
    entries.push("default");
    entries.push('skip_serializing_if = "Option::is_none"');
  }

  return entries.length > 0 ? [`#[serde(${entries.join(", ")})]`] : [];
}

function toRustFieldName(wireName: string): string {
  const snake = toSnakeCase(wireName);
  return rustKeywords.has(snake) ? `${snake}_` : snake;
}

function nestedTypeNameForField(
  parentTypeName: string,
  wireName: string,
  schema: JsonObject,
): string {
  let fieldName = toPascalCase(wireName);
  if (
    schema.type === "array" &&
    fieldName.endsWith("s") &&
    fieldName.length > 1
  ) {
    fieldName = fieldName.slice(0, -1);
  }

  return `${parentTypeName}${fieldName}`;
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_, char: string) => {
    return char.toUpperCase();
  });
}

function toPascalCase(value: string): string {
  const words = value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+|_/)
    .filter((word) => {
      return word.length > 0;
    });
  const pascal = words
    .map((word) => {
      return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    })
    .join("");

  return pascal.length > 0 ? pascal : "Value";
}

function toRustVariantName(value: string): string {
  const variant = toPascalCase(value);
  const name = /^[0-9]/.test(variant) ? `V${variant}` : variant;
  return rustKeywords.has(name) ? `${name}_` : name;
}

function compareAscii(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function appendBlankLineIfNeeded(lines: string[]): void {
  if (lines.length > 0) {
    lines.push("");
  }
}

function rustStringLiteral(value: string): string {
  let literal = '"';

  for (const char of value) {
    if (char === "\\") {
      literal += "\\\\";
    } else if (char === '"') {
      literal += '\\"';
    } else if (char === "\n") {
      literal += "\\n";
    } else if (char === "\r") {
      literal += "\\r";
    } else if (char === "\t") {
      literal += "\\t";
    } else {
      const codePoint = char.codePointAt(0);
      if (codePoint !== undefined && codePoint < 0x20) {
        literal += `\\u{${codePoint.toString(16)}}`;
      } else {
        literal += char;
      }
    }
  }

  return `${literal}"`;
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isMainModule()) {
  void generateRustBindings().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
