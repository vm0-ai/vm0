import { createHash } from "node:crypto";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface BuiltinFirewallRuntimePermission {
  readonly name: string;
  readonly rules: readonly string[];
  readonly [key: string]: unknown;
}

export interface BuiltinFirewallRuntimeApi {
  readonly base: string;
  readonly auth: unknown;
  readonly permissions?: readonly BuiltinFirewallRuntimePermission[];
  readonly [key: string]: unknown;
}

export interface BuiltinFirewallRuntimeFirewall {
  readonly name: string;
  readonly apis: readonly BuiltinFirewallRuntimeApi[];
  readonly [key: string]: unknown;
}

export type PythonBuiltinFirewallDiagnosticKind = "connector" | "modelProvider";

export interface PythonBuiltinFirewallCatalogEntry {
  readonly firewall: BuiltinFirewallRuntimeFirewall;
  readonly diagnosticKind: PythonBuiltinFirewallDiagnosticKind;
}

export interface PythonBuiltinFirewallCatalogFile {
  readonly path: string;
  readonly content: string;
}

export interface RenderPythonBuiltinFirewallCatalogOptions {
  readonly entries: readonly PythonBuiltinFirewallCatalogEntry[];
  readonly generatedHeader: readonly string[];
  readonly maxJsonChunkLength?: number;
}

interface DiagnosticConnectorApi {
  readonly base: string;
  readonly envNames: readonly string[];
  readonly authHeaderNames: readonly string[];
  readonly authQueryParamNames: readonly string[];
}

interface DiagnosticConnectorFirewall {
  readonly name: string;
  readonly apis: readonly DiagnosticConnectorApi[];
}

interface DiagnosticPermission {
  readonly name: string;
  readonly rules: readonly string[];
}

interface DiagnosticModelProviderApi {
  readonly base: string;
  readonly permissions: readonly DiagnosticPermission[];
}

interface DiagnosticModelProviderFirewall {
  readonly name: string;
  readonly apis: readonly DiagnosticModelProviderApi[];
}

interface BuiltinFirewallDiagnosticManifest {
  readonly connectorFirewalls: readonly DiagnosticConnectorFirewall[];
  readonly modelProviderExclusions: readonly DiagnosticModelProviderFirewall[];
}

const DEFAULT_FIREWALL_JSON_CHUNK_LENGTH = 200_000;
const MAX_GENERATED_PYTHON_LINE_LENGTH = 512;
const MAX_PYTHON_MODULE_BASE_LENGTH = 96;
const PYTHON_MODULE_HASH_LENGTH = 12;
const PYTHON_JSON_PART_ASSIGNMENT_PREFIX = "JSON_PART = ";
const DIAGNOSTIC_JSON_ASSIGNMENT_PREFIX =
  "MODEL_PROVIDER_DIAGNOSTIC_EXCLUSIONS = json.loads(";
// Fallback JSON string literals can double quotes and backslashes.
const MAX_JSON_PART_SOURCE_CHARS = Math.floor(
  (MAX_GENERATED_PYTHON_LINE_LENGTH -
    PYTHON_JSON_PART_ASSIGNMENT_PREFIX.length -
    2) /
    2,
);
const MAX_DIAGNOSTIC_JSON_SOURCE_CHARS = Math.floor(
  (MAX_GENERATED_PYTHON_LINE_LENGTH -
    DIAGNOSTIC_JSON_ASSIGNMENT_PREFIX.length -
    3) /
    2,
);
const DIAGNOSTIC_REFERENCE_NAME_PATTERN =
  /\b(?:secrets|vars)\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

function hasDynamicBaseMarker(base: string): boolean {
  return base.includes("{") || base.includes("}");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainJsonObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function extractDiagnosticReferenceNames(value: unknown): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const ancestors = new WeakSet<object>();

  function add(name: string): void {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    result.push(name);
  }

  function visit(nested: unknown): void {
    if (typeof nested === "string") {
      DIAGNOSTIC_REFERENCE_NAME_PATTERN.lastIndex = 0;
      for (
        let match = DIAGNOSTIC_REFERENCE_NAME_PATTERN.exec(nested);
        match !== null;
        match = DIAGNOSTIC_REFERENCE_NAME_PATTERN.exec(nested)
      ) {
        const name = match[1];
        if (name !== undefined) {
          add(name);
        }
      }
      return;
    }
    if (Array.isArray(nested)) {
      if (ancestors.has(nested)) {
        throw new Error("unsupported circular JSON catalog value");
      }
      ancestors.add(nested);
      try {
        for (const item of nested) {
          visit(item);
        }
      } finally {
        ancestors.delete(nested);
      }
      return;
    }
    if (!isRecord(nested)) {
      return;
    }
    if (ancestors.has(nested)) {
      throw new Error("unsupported circular JSON catalog value");
    }
    ancestors.add(nested);
    try {
      for (const key of Object.keys(nested).sort()) {
        visit(nested[key]);
      }
    } finally {
      ancestors.delete(nested);
    }
  }

  visit(value);
  return result;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

function diagnosticAuthHeaderNames(auth: unknown): readonly string[] {
  if (!isRecord(auth)) {
    return [];
  }
  return Object.keys(stringRecord(auth.headers))
    .filter((name) => {
      return name.length > 0;
    })
    .sort();
}

function diagnosticAuthQueryParamNames(auth: unknown): readonly string[] {
  if (!isRecord(auth)) {
    return [];
  }
  return Object.keys(stringRecord(auth.query))
    .filter((name) => {
      return name.length > 0;
    })
    .sort();
}

function diagnosticConnectorApi(
  api: BuiltinFirewallRuntimeApi,
): DiagnosticConnectorApi | null {
  if (hasDynamicBaseMarker(api.base)) {
    return null;
  }

  const envNames = extractDiagnosticReferenceNames(api.auth);
  if (envNames.length === 0) {
    return null;
  }

  return {
    base: api.base,
    envNames,
    authHeaderNames: diagnosticAuthHeaderNames(api.auth),
    authQueryParamNames: diagnosticAuthQueryParamNames(api.auth),
  };
}

function diagnosticPermissions(
  permissions: BuiltinFirewallRuntimeApi["permissions"],
): readonly DiagnosticPermission[] {
  if (permissions === undefined) {
    return [];
  }
  return permissions.map((permission) => {
    return {
      name: permission.name,
      rules: [...permission.rules],
    };
  });
}

function diagnosticModelProviderApi(
  api: BuiltinFirewallRuntimeApi,
): DiagnosticModelProviderApi | null {
  if (hasDynamicBaseMarker(api.base)) {
    return null;
  }

  return {
    base: api.base,
    permissions: diagnosticPermissions(api.permissions),
  };
}

function buildBuiltinFirewallDiagnosticManifest(
  entries: readonly PythonBuiltinFirewallCatalogEntry[],
): BuiltinFirewallDiagnosticManifest {
  const connectorFirewalls: DiagnosticConnectorFirewall[] = [];
  const modelProviderExclusions: DiagnosticModelProviderFirewall[] = [];

  for (const entry of entries) {
    const { firewall } = entry;
    if (entry.diagnosticKind === "modelProvider") {
      const apis = firewall.apis
        .map(diagnosticModelProviderApi)
        .filter((api): api is DiagnosticModelProviderApi => {
          return api !== null;
        });
      if (apis.length > 0) {
        modelProviderExclusions.push({
          name: firewall.name,
          apis,
        });
      }
      continue;
    }

    const apis = firewall.apis
      .map(diagnosticConnectorApi)
      .filter((api): api is DiagnosticConnectorApi => {
        return api !== null;
      });
    if (apis.length > 0) {
      connectorFirewalls.push({
        name: firewall.name,
        apis,
      });
    }
  }

  return {
    connectorFirewalls,
    modelProviderExclusions,
  };
}

function sortJson(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`unsupported JSON catalog number: ${value}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error("unsupported circular JSON catalog value");
    }
    ancestors.add(value);
    try {
      return value.map((item) => {
        return sortJson(item, ancestors);
      });
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value !== "object") {
    throw new Error(`unsupported JSON catalog value: ${typeof value}`);
  }
  if (!isPlainJsonObject(value)) {
    const constructorName = value.constructor?.name ?? "unknown";
    throw new Error(`unsupported JSON catalog object: ${constructorName}`);
  }

  const sorted: Record<string, JsonValue> = {};
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("unsupported JSON catalog object symbol key");
  }
  if (ancestors.has(value)) {
    throw new Error("unsupported circular JSON catalog value");
  }
  ancestors.add(value);
  try {
    for (const key of Object.keys(value).sort()) {
      const nested = value[key];
      if (nested === undefined) {
        throw new Error("unsupported JSON catalog value: undefined");
      }
      sorted[key] = sortJson(nested, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
  return sorted;
}

function unicodeEscape(codePoint: number): string {
  return `\\u${codePoint.toString(16).padStart(4, "0")}`;
}

function escapeNonAsciiJson(value: string): string {
  let escaped = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      throw new Error("failed to read JSON code point");
    }
    if (codePoint <= 0x7f) {
      escaped += char;
      continue;
    }
    if (codePoint <= 0xffff) {
      escaped += unicodeEscape(codePoint);
      continue;
    }

    const shifted = codePoint - 0x10000;
    escaped += unicodeEscape(0xd800 + (shifted >> 10));
    escaped += unicodeEscape(0xdc00 + (shifted & 0x3ff));
  }
  return escaped;
}

function stablePrettyJson(value: unknown): string {
  const json = JSON.stringify(sortJson(value), null, 2);
  if (json === undefined) {
    throw new Error("failed to encode firewall catalog JSON");
  }
  return escapeNonAsciiJson(json);
}

function pythonEscapedStringLiteral(value: string): string {
  const literal = JSON.stringify(value);
  if (literal === undefined) {
    throw new Error("failed to encode Python string literal");
  }
  return literal;
}

function splitPythonStringLiteralChunks(
  value: string,
  maxLiteralLength: number,
): readonly string[] {
  if (!Number.isInteger(maxLiteralLength) || maxLiteralLength < 2) {
    throw new Error(
      `invalid Python string literal length: ${maxLiteralLength}`,
    );
  }

  const chunks: string[] = [];
  let current = "";
  for (const char of value) {
    const candidate = `${current}${char}`;
    if (
      current.length > 0 &&
      pythonEscapedStringLiteral(candidate).length > maxLiteralLength
    ) {
      chunks.push(current);
      current = char;
      if (pythonEscapedStringLiteral(current).length > maxLiteralLength) {
        throw new Error("failed to split Python string literal");
      }
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks : [""];
}

function renderPythonStringExpressionLines({
  value,
  prefix,
  continuationIndent,
  closingIndent,
  suffix,
}: {
  readonly value: string;
  readonly prefix: string;
  readonly continuationIndent: string;
  readonly closingIndent: string;
  readonly suffix: string;
}): readonly string[] {
  const literal = pythonEscapedStringLiteral(value);
  if (
    prefix.length + literal.length + suffix.length <=
    MAX_GENERATED_PYTHON_LINE_LENGTH
  ) {
    return [`${prefix}${literal}${suffix}`];
  }

  if (prefix.length + "(".length > MAX_GENERATED_PYTHON_LINE_LENGTH) {
    throw new Error("invalid Python string expression prefix");
  }
  if (
    closingIndent.length + ")".length + suffix.length >
    MAX_GENERATED_PYTHON_LINE_LENGTH
  ) {
    throw new Error("invalid Python string expression suffix");
  }

  const maxLiteralLength =
    MAX_GENERATED_PYTHON_LINE_LENGTH - continuationIndent.length;
  return [
    `${prefix}(`,
    ...splitPythonStringLiteralChunks(value, maxLiteralLength).map((chunk) => {
      return `${continuationIndent}${pythonEscapedStringLiteral(chunk)}`;
    }),
    `${closingIndent})${suffix}`,
  ];
}

function hasOddTrailingBackslashes(value: string): boolean {
  let count = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] !== "\\") {
      break;
    }
    count += 1;
  }
  return count % 2 === 1;
}

function pythonJsonChunkLiteral(value: string): string {
  if (
    !value.includes('"""') &&
    !value.endsWith('"') &&
    !hasOddTrailingBackslashes(value)
  ) {
    return `r"""${value}"""`;
  }
  return pythonEscapedStringLiteral(value);
}

function hashPythonModuleBase(name: string): string {
  return createHash("sha256")
    .update(name)
    .digest("hex")
    .slice(0, PYTHON_MODULE_HASH_LENGTH);
}

function boundPythonModuleBase(name: string, base: string): string {
  if (base.length <= MAX_PYTHON_MODULE_BASE_LENGTH) {
    return base;
  }

  const hash = hashPythonModuleBase(name);
  const prefixLength = MAX_PYTHON_MODULE_BASE_LENGTH - hash.length - "_".length;
  const prefix = base.slice(0, prefixLength).replace(/_+$/g, "");
  return `${prefix.length > 0 ? prefix : "firewall"}_${hash}`;
}

function sanitizePythonModuleBase(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  let base: string;
  if (sanitized.length === 0) {
    base = "firewall";
  } else if (/^[a-z_]/.test(sanitized)) {
    base = sanitized;
  } else {
    base = `firewall_${sanitized}`;
  }
  return boundPythonModuleBase(name, base);
}

function uniqueModuleBaseNames(
  names: readonly string[],
): ReadonlyMap<string, string> {
  const used = new Set<string>();
  const bases = new Map<string, string>();

  for (const name of names) {
    const base = sanitizePythonModuleBase(name);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    bases.set(name, candidate);
  }

  return bases;
}

function splitJsonLines(value: string, maxLength: number): readonly string[] {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new Error(`invalid firewall JSON chunk length: ${maxLength}`);
  }

  const maxSegmentLength = Math.min(maxLength, MAX_JSON_PART_SOURCE_CHARS);
  const chunks: string[] = [];
  let current = "";
  const lines = value.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      throw new Error("failed to read firewall JSON line");
    }
    const segment = index < lines.length - 1 ? `${line}\n` : line;
    if (segment.length > maxSegmentLength) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      for (
        let offset = 0;
        offset < segment.length;
        offset += maxSegmentLength
      ) {
        const piece = segment.slice(offset, offset + maxSegmentLength);
        if (offset + maxSegmentLength < segment.length) {
          chunks.push(piece);
        } else {
          current = piece;
        }
      }
      continue;
    }
    if (current.length > 0 && current.length + segment.length > maxLength) {
      chunks.push(current);
      current = "";
    }
    current += segment;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks : [""];
}

function renderPythonPackageInit(generatedHeader: readonly string[]): string {
  return [
    ...generatedHeader,
    "",
    "import json",
    "from collections.abc import Iterator, Mapping",
    "from typing import Any",
    "",
    "from .loader import load_json_parts",
    "from .manifest import FIREWALL_MODULES",
    "",
    "",
    "class _BuiltinFirewallCatalog(Mapping[str, dict[str, Any]]):",
    "    def __init__(self) -> None:",
    "        self._cache: dict[str, dict[str, Any]] = {}",
    "",
    "    def __getitem__(self, name: str) -> dict[str, Any]:",
    "        if name not in FIREWALL_MODULES:",
    "            raise KeyError(name)",
    "        if name not in self._cache:",
    "            self._cache[name] = self._load(name)",
    "        return self._cache[name]",
    "",
    "    def __iter__(self) -> Iterator[str]:",
    "        return iter(FIREWALL_MODULES)",
    "",
    "    def __len__(self) -> int:",
    "        return len(FIREWALL_MODULES)",
    "",
    "    def __contains__(self, name: object) -> bool:",
    "        return name in FIREWALL_MODULES",
    "",
    "    def _load(self, name: str) -> dict[str, Any]:",
    "        parts = load_json_parts(name)",
    '        value = json.loads("".join(parts))',
    "        if not isinstance(value, dict):",
    '            raise TypeError(f"builtin firewall {name} is not a JSON object")',
    "        return value",
    "",
    "",
    "BUILTIN_FIREWALLS = _BuiltinFirewallCatalog()",
    "",
  ].join("\n");
}

function renderPythonLoader(
  generatedHeader: readonly string[],
  modulesByFirewall: ReadonlyMap<string, readonly string[]>,
): string {
  const lines = [
    ...generatedHeader,
    "",
    "",
    "def load_json_parts(name: str) -> tuple[str, ...]:",
  ];

  for (const [name, modules] of modulesByFirewall) {
    lines.push(
      ...renderPythonStringExpressionLines({
        value: name,
        prefix: "    if name == ",
        continuationIndent: "        ",
        closingIndent: "    ",
        suffix: ":",
      }),
    );
    for (const moduleName of modules) {
      lines.push(`        from . import ${moduleName}`);
    }
    lines.push("");
    if (modules.length > 1) {
      lines.push("        return (");
      for (const moduleName of modules) {
        lines.push(`            ${moduleName}.JSON_PART,`);
      }
      lines.push("        )");
      continue;
    }

    const renderedParts = modules
      .map((moduleName) => {
        return `${moduleName}.JSON_PART`;
      })
      .join(", ");
    const tupleSuffix = modules.length === 1 ? "," : "";
    lines.push(`        return (${renderedParts}${tupleSuffix})`);
  }

  lines.push("    raise KeyError(name)", "");
  return lines.join("\n");
}

function renderPythonManifest(
  generatedHeader: readonly string[],
  modulesByFirewall: ReadonlyMap<string, readonly string[]>,
): string {
  const lines = [...generatedHeader, "", "FIREWALL_MODULES = {"];

  for (const [name, modules] of modulesByFirewall) {
    const renderedModules = modules
      .map((moduleName) => {
        return pythonEscapedStringLiteral(moduleName);
      })
      .join(", ");
    const tupleSuffix = modules.length === 1 ? "," : "";
    if (modules.length > 1) {
      lines.push(
        ...renderPythonStringExpressionLines({
          value: name,
          prefix: "    ",
          continuationIndent: "        ",
          closingIndent: "    ",
          suffix: ": (",
        }),
      );
      for (const moduleName of modules) {
        lines.push(`        ${pythonEscapedStringLiteral(moduleName)},`);
      }
      lines.push("    ),");
      continue;
    }

    lines.push(
      ...renderPythonStringExpressionLines({
        value: name,
        prefix: "    ",
        continuationIndent: "        ",
        closingIndent: "    ",
        suffix: `: (${renderedModules}${tupleSuffix}),`,
      }),
    );
  }

  lines.push("}", "");
  return lines.join("\n");
}

function renderPythonDiagnosticManifest(
  generatedHeader: readonly string[],
  manifest: BuiltinFirewallDiagnosticManifest,
): string {
  const connectorAssignment = renderPythonJsonAssignment(
    "CONNECTOR_DIAGNOSTIC_FIREWALLS",
    manifest.connectorFirewalls,
  );
  const modelProviderAssignment = renderPythonJsonAssignment(
    "MODEL_PROVIDER_DIAGNOSTIC_EXCLUSIONS",
    manifest.modelProviderExclusions,
  );

  return [
    ...generatedHeader,
    "",
    "import json",
    "",
    "# fmt: off",
    ...connectorAssignment,
    "",
    ...modelProviderAssignment,
    "",
    "# fmt: on",
    "",
  ].join("\n");
}

function renderPythonJsonAssignment(
  name: string,
  value: unknown,
): readonly string[] {
  const json = stablePrettyJson(value);
  const assignmentPrefix = `${name} = json.loads(`;
  const inlineLiteral = pythonRawJsonLiteralForAssignment(
    json,
    assignmentPrefix.length,
  );
  if (inlineLiteral !== null) {
    return [`${assignmentPrefix}${inlineLiteral})`];
  }

  const chunks = splitJsonLines(json, MAX_DIAGNOSTIC_JSON_SOURCE_CHARS);
  if (chunks.length === 1) {
    const chunk = chunks[0];
    if (chunk === undefined) {
      throw new Error(`missing generated Python JSON assignment for ${name}`);
    }
    return [`${assignmentPrefix}${pythonJsonChunkLiteral(chunk)})`];
  }

  return [
    assignmentPrefix,
    '    "".join((',
    ...chunks.map((chunk) => {
      return `        ${pythonJsonChunkLiteral(chunk)},`;
    }),
    "    ))",
    ")",
  ];
}

function pythonRawJsonLiteralForAssignment(
  value: string,
  assignmentPrefixLength: number,
): string | null {
  if (
    value.includes('"""') ||
    value.endsWith('"') ||
    hasOddTrailingBackslashes(value)
  ) {
    return null;
  }

  const lines = value.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      throw new Error("failed to read Python JSON assignment line");
    }

    const isFirstLine = index === 0;
    const isLastLine = index === lines.length - 1;
    const renderedLineLength =
      (isFirstLine ? assignmentPrefixLength + 'r"""'.length : 0) +
      line.length +
      (isLastLine ? '""")'.length : 0);
    if (renderedLineLength > MAX_GENERATED_PYTHON_LINE_LENGTH) {
      return null;
    }
  }

  return `r"""${value}"""`;
}

function renderPythonJsonPartModule(
  generatedHeader: readonly string[],
  jsonPart: string,
): string {
  return [
    ...generatedHeader,
    "",
    `${PYTHON_JSON_PART_ASSIGNMENT_PREFIX}${pythonJsonChunkLiteral(jsonPart)}`,
    "",
  ].join("\n");
}

function sortedUniqueEntries(
  entries: readonly PythonBuiltinFirewallCatalogEntry[],
): readonly PythonBuiltinFirewallCatalogEntry[] {
  const entriesByName = new Map<string, PythonBuiltinFirewallCatalogEntry>();
  for (const entry of entries) {
    const { name } = entry.firewall;
    if (entriesByName.has(name)) {
      throw new Error(`duplicate built-in firewall catalog name: ${name}`);
    }
    entriesByName.set(name, entry);
  }
  return [...entriesByName.values()].sort((a, b) => {
    return a.firewall.name < b.firewall.name
      ? -1
      : a.firewall.name > b.firewall.name
        ? 1
        : 0;
  });
}

export function renderPythonBuiltinFirewallCatalogFiles(
  options: RenderPythonBuiltinFirewallCatalogOptions,
): readonly PythonBuiltinFirewallCatalogFile[] {
  const entries = sortedUniqueEntries(options.entries);
  const diagnosticManifest = buildBuiltinFirewallDiagnosticManifest(entries);
  const maxJsonChunkLength =
    options.maxJsonChunkLength ?? DEFAULT_FIREWALL_JSON_CHUNK_LENGTH;
  const { generatedHeader } = options;
  const names = entries.map((entry) => {
    return entry.firewall.name;
  });
  const moduleBaseNames = uniqueModuleBaseNames(names);
  const modulesByFirewall = new Map<string, readonly string[]>();
  const partFiles: PythonBuiltinFirewallCatalogFile[] = [];

  for (const entry of entries) {
    const { firewall } = entry;
    const baseName = moduleBaseNames.get(firewall.name);
    if (baseName === undefined) {
      throw new Error(
        `missing Python module name for firewall: ${firewall.name}`,
      );
    }

    const chunks = splitJsonLines(
      stablePrettyJson(firewall),
      maxJsonChunkLength,
    );
    const moduleNames = chunks.map((_, index) => {
      return `${baseName}_${index}`;
    });
    modulesByFirewall.set(firewall.name, moduleNames);

    for (let index = 0; index < chunks.length; index += 1) {
      const moduleName = moduleNames[index];
      const chunk = chunks[index];
      if (moduleName === undefined || chunk === undefined) {
        throw new Error(
          `missing generated Python chunk for firewall: ${firewall.name}`,
        );
      }
      partFiles.push({
        path: `${moduleName}.py`,
        content: renderPythonJsonPartModule(generatedHeader, chunk),
      });
    }
  }

  return [
    {
      path: "__init__.py",
      content: renderPythonPackageInit(generatedHeader),
    },
    {
      path: "manifest.py",
      content: renderPythonManifest(generatedHeader, modulesByFirewall),
    },
    {
      path: "loader.py",
      content: renderPythonLoader(generatedHeader, modulesByFirewall),
    },
    {
      path: "diagnostics.py",
      content: renderPythonDiagnosticManifest(
        generatedHeader,
        diagnosticManifest,
      ),
    },
    ...partFiles,
  ];
}
