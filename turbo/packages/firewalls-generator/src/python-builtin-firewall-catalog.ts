import { createHash } from "node:crypto";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type DataPropertyDescriptor = PropertyDescriptor & {
  readonly value: unknown;
};

export interface BuiltinFirewallRuntimePermission {
  readonly name: string;
  readonly rules: readonly string[];
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

interface RenderPythonBuiltinFirewallCatalogOptions {
  readonly entries: readonly PythonBuiltinFirewallCatalogEntry[];
  readonly generatedHeader: readonly string[];
  readonly maxJsonChunkLength?: number;
}

interface DiagnosticConnectorApi {
  readonly base: string;
  readonly envNames: readonly string[];
  readonly authHeaderNames: readonly string[];
  readonly authQueryParamNames: readonly string[];
  readonly permissions?: readonly DiagnosticPermission[];
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
// Scripts that Node URL accepts directly but Python's bidi validation can reject.
const RUNTIME_BIDI_RTL_SCRIPT_PATTERN =
  /^(?:\p{Script=Arabic}|\p{Script=Old_Uyghur})$/u;
const ASCII_LETTER_PATTERN = /^[A-Za-z]$/;
const ASCII_PUNCTUATION_PATTERN =
  /^[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]$/;
const HEX_DIGIT_PATTERN = /^[0-9a-fA-F]$/;
const UNICODE_MARK_PATTERN = /^\p{Mark}$/u;
const UNICODE_OTHER_PATTERN = /^\p{Other}$/u;
const PERCENT_DECODED_FORBIDDEN_HOST_CHARS = new Set([
  "#",
  "%",
  "/",
  "<",
  ">",
  "?",
  "@",
  "[",
  "\\",
  "]",
  "^",
  "|",
  "{",
  "}",
  "*",
  ".",
  ":",
  "\u3002",
  "\uff0e",
  "\uff61",
]);
const FORBIDDEN_RUNTIME_HOST_LABEL_CHARS = new Set([
  "#",
  "%",
  ",",
  "/",
  ":",
  "<",
  ">",
  "?",
  "@",
  "[",
  "\\",
  "]",
  "^",
  "|",
  "{",
  "}",
  "*",
]);
const FORBIDDEN_RUNTIME_NORMALIZED_HOST_LABEL_CHARS = new Set([
  "#",
  "%",
  ",",
  "/",
  ":",
  "<",
  ">",
  "?",
  "@",
  "[",
  "\\",
  "]",
  "^",
  "|",
  ".",
  "\u3002",
  "\uff0e",
  "\uff61",
]);
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
const IDNA_DOT_VARIANT_PATTERN = /[\u3002\uff0e\uff61]/g;
const IPV4_MAX_OCTET = 255;
const UNSAFE_UTS46_COLLISION_CODEPOINTS = new Set([
  0x03f2, 0x04c0, 0x1e9e, 0x1806, 0x2132, 0x2183, 0x3164, 0xffa0, 0xfffc,
  0xfffd, 0x2f868, 0x2f874, 0x2f91f, 0x2f95f, 0x2f9bf,
]);
const UNSAFE_UTS46_COLLISION_RANGES = [
  [0x10a0, 0x10c5],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x2ff0, 0x2ffb],
] as const;
const UNSAFE_UTS46_IGNORABLE_RANGES = [
  [0x034f, 0x034f],
  [0x180b, 0x180d],
  [0x180f, 0x180f],
  [0xfe00, 0xfe0f],
  [0xe0100, 0xe01ef],
] as const;

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

function isDataPropertyDescriptor(
  descriptor: PropertyDescriptor,
): descriptor is DataPropertyDescriptor {
  return "value" in descriptor;
}

function isArrayIndexKey(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function objectConstructorName(value: object): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) {
    return "unknown";
  }

  const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
  if (
    descriptor === undefined ||
    !isDataPropertyDescriptor(descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    return "unknown";
  }

  return descriptor.value.name;
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

function stripSingleHostnameTrailingDot(value: string): string {
  if (!value.endsWith(".")) {
    return value;
  }

  const stripped = value.slice(0, -1);
  if (stripped.length === 0 || stripped.endsWith(".")) {
    return value;
  }

  return stripped;
}

function stripHostnameTrailingDot(host: string): string {
  const portStart = host.startsWith("[") ? -1 : host.lastIndexOf(":");
  if (portStart === -1) {
    return stripSingleHostnameTrailingDot(host);
  }

  const hostname = stripSingleHostnameTrailingDot(host.slice(0, portStart));
  return `${hostname}${host.slice(portStart)}`;
}

function rawUrlAuthority(base: string): string | null {
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(base);
  if (schemeMatch === null) {
    return null;
  }

  const authorityStart = schemeMatch[0].length;
  const authoritySuffix = base.slice(authorityStart);
  const authorityEnd = authoritySuffix.search(/[/?#]/);
  const end = authorityEnd === -1 ? base.length : authorityStart + authorityEnd;
  const authority = base.slice(authorityStart, end);
  return authority.length > 0 ? authority : null;
}

function rawUrlPath(base: string): string | null {
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(base);
  if (schemeMatch === null) {
    return null;
  }

  const authorityStart = schemeMatch[0].length;
  const authoritySuffix = base.slice(authorityStart);
  const authorityEnd = authoritySuffix.search(/[/?#]/);
  if (authorityEnd === -1) {
    return "";
  }

  const separatorIndex = authorityStart + authorityEnd;
  if (base[separatorIndex] !== "/") {
    return "";
  }

  const pathSuffix = base.slice(separatorIndex);
  const queryOrFragmentStart = pathSuffix.search(/[?#]/);
  return queryOrFragmentStart === -1
    ? pathSuffix
    : pathSuffix.slice(0, queryOrFragmentStart);
}

function rawAuthorityHostPort(authority: string): string {
  const userInfoEnd = authority.lastIndexOf("@");
  return userInfoEnd === -1 ? authority : authority.slice(userInfoEnd + 1);
}

function rawAuthorityHasEmptyPort(authority: string): boolean {
  return rawAuthorityHostPort(authority).endsWith(":");
}

function rawAuthorityHostname(authority: string): string | null {
  const hostPort = rawAuthorityHostPort(authority);
  if (hostPort.length === 0) {
    return null;
  }

  if (hostPort.startsWith("[")) {
    const closeIndex = hostPort.indexOf("]");
    if (closeIndex === -1) {
      return null;
    }
    const rest = hostPort.slice(closeIndex + 1);
    if (rest.length > 0 && !rest.startsWith(":")) {
      return null;
    }
    return hostPort.slice(1, closeIndex);
  }

  if (hostPort.split(":").length === 2) {
    return hostPort.slice(0, hostPort.lastIndexOf(":"));
  }

  return hostPort;
}

function hostnameHasEmptyLabel(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return false;
  }

  const normalizedHostname = stripSingleHostnameTrailingDot(hostname);
  return normalizedHostname.split(".").some((label) => {
    return label.length === 0;
  });
}

function isSurrogateCodepoint(codepoint: number): boolean {
  return codepoint >= 0xd800 && codepoint <= 0xdfff;
}

function isAsciiSpaceOrControl(value: string): boolean {
  for (const char of value) {
    const codepoint = char.codePointAt(0);
    if (
      codepoint !== undefined &&
      (codepoint <= 0x20 ||
        codepoint === 0x7f ||
        isSurrogateCodepoint(codepoint))
    ) {
      return true;
    }
  }
  return false;
}

function isAuthoritySpaceOrControl(value: string): boolean {
  for (const char of value) {
    const codepoint = char.codePointAt(0);
    if (
      codepoint !== undefined &&
      (/\s/u.test(char) || codepoint < 0x20 || codepoint === 0x7f)
    ) {
      return true;
    }
  }
  return false;
}

function percentDecodeRuntimeSafeHostname(hostname: string): string | null {
  let index = 0;
  let decodedHostname = "";
  while (index < hostname.length) {
    if (hostname[index] !== "%") {
      decodedHostname += hostname[index];
      index += 1;
      continue;
    }

    let encoded = "";
    while (hostname[index] === "%") {
      const first = hostname[index + 1];
      const second = hostname[index + 2];
      if (
        first === undefined ||
        second === undefined ||
        !HEX_DIGIT_PATTERN.test(first) ||
        !HEX_DIGIT_PATTERN.test(second)
      ) {
        return null;
      }
      encoded += `%${first}${second}`;
      index += 3;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    if (isAuthoritySpaceOrControl(decoded)) {
      return null;
    }
    for (const char of decoded) {
      if (PERCENT_DECODED_FORBIDDEN_HOST_CHARS.has(char)) {
        return null;
      }
    }
    decodedHostname += decoded;
  }
  return decodedHostname;
}

function isIpv4NumberComponent(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  if (value.toLowerCase().startsWith("0x")) {
    return (
      value.length > 2 &&
      [...value.slice(2)].every((char) => {
        return HEX_DIGIT_PATTERN.test(char);
      })
    );
  }
  return /^[0-9]+$/.test(value);
}

function isIpv4LiteralLike(hostname: string): boolean {
  const parts = hostname.split(".");
  return (
    parts.length >= 1 &&
    parts.length <= 4 &&
    parts.every((part) => {
      return isIpv4NumberComponent(part);
    })
  );
}

function isCanonicalIpv4Address(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => {
    if (!/^[0-9]+$/.test(part)) {
      return false;
    }
    if (part.length > 1 && part.startsWith("0")) {
      return false;
    }
    return Number(part) <= IPV4_MAX_OCTET;
  });
}

function isCodepointInRanges(
  codepoint: number,
  ranges: readonly (readonly [number, number])[],
): boolean {
  return ranges.some(([start, end]) => {
    return codepoint >= start && codepoint <= end;
  });
}

function hasUnsafeUts46MappingChars(value: string): boolean {
  for (const char of value) {
    const codepoint = char.codePointAt(0);
    if (
      codepoint !== undefined &&
      (UNSAFE_UTS46_COLLISION_CODEPOINTS.has(codepoint) ||
        isCodepointInRanges(codepoint, UNSAFE_UTS46_COLLISION_RANGES) ||
        isCodepointInRanges(codepoint, UNSAFE_UTS46_IGNORABLE_RANGES))
    ) {
      return true;
    }
  }
  return false;
}

function hasForbiddenRuntimeHostLabelChars(value: string): boolean {
  for (const char of value) {
    if (FORBIDDEN_RUNTIME_HOST_LABEL_CHARS.has(char)) {
      return true;
    }
  }
  return false;
}

function runtimeLowerNormalizedLabel(value: string): string {
  // Match Python's normalize-then-per-codepoint-lower order.
  return [...value.normalize("NFKD").normalize("NFC")]
    .map((char) => {
      return char === "\u03a3" ? "\u03c3" : char.toLowerCase();
    })
    .join("");
}

function hasRuntimeIncompatibleNormalizedLabelText(value: string): boolean {
  const normalized = runtimeLowerNormalizedLabel(value);
  if (normalized !== normalized.normalize("NFC")) {
    return true;
  }

  const firstChar = [...normalized][0];
  if (firstChar === undefined || UNICODE_MARK_PATTERN.test(firstChar)) {
    return true;
  }

  for (const char of normalized) {
    if (
      FORBIDDEN_RUNTIME_NORMALIZED_HOST_LABEL_CHARS.has(char) ||
      /\s/u.test(char) ||
      UNICODE_OTHER_PATTERN.test(char)
    ) {
      return true;
    }
  }
  return false;
}

function hasRuntimeIncompatibleBidiLabel(value: string): boolean {
  const chars = [...value];
  const firstRtlIndex = chars.findIndex((char) => {
    return RUNTIME_BIDI_RTL_SCRIPT_PATTERN.test(char);
  });
  if (firstRtlIndex === -1) {
    return false;
  }

  const prefix = chars.slice(0, firstRtlIndex);
  const suffix = chars.slice(firstRtlIndex + 1);
  const prefixHasAsciiLetter = prefix.some((char) => {
    return ASCII_LETTER_PATTERN.test(char);
  });
  if (
    prefixHasAsciiLetter &&
    suffix.some((char) => {
      return !UNICODE_MARK_PATTERN.test(char);
    })
  ) {
    return true;
  }
  if (
    suffix.some((char) => {
      return ASCII_LETTER_PATTERN.test(char);
    })
  ) {
    return true;
  }

  const lastSuffixChar = suffix.at(-1);
  return (
    lastSuffixChar !== undefined &&
    ASCII_PUNCTUATION_PATTERN.test(lastSuffixChar)
  );
}

function stripRuntimeHostnameTrailingDot(hostname: string): string | null {
  if (!hostname.endsWith(".")) {
    return hostname;
  }
  const stripped = hostname.slice(0, -1);
  return stripped.length > 0 && !stripped.endsWith(".") ? stripped : null;
}

function runtimeCompatibleHostname(
  rawHostname: string,
  parsedHostname: string,
): boolean {
  const decodedHostname = percentDecodeRuntimeSafeHostname(rawHostname);
  if (decodedHostname === null || decodedHostname.includes("*")) {
    return false;
  }
  if (decodedHostname.includes(":")) {
    return true;
  }

  const dottedHostname = decodedHostname.replace(IDNA_DOT_VARIANT_PATTERN, ".");
  const normalizedHostname = stripRuntimeHostnameTrailingDot(dottedHostname);
  if (normalizedHostname === null || normalizedHostname.length === 0) {
    return false;
  }
  if (isIpv4LiteralLike(normalizedHostname)) {
    return isCanonicalIpv4Address(normalizedHostname);
  }

  const parsedLabels = stripSingleHostnameTrailingDot(
    parsedHostname.toLowerCase(),
  ).split(".");
  const rawLabels = normalizedHostname.split(".");
  if (rawLabels.length !== parsedLabels.length) {
    return false;
  }

  for (let index = 0; index < rawLabels.length; index += 1) {
    const rawLabel = rawLabels[index];
    const parsedLabel = parsedLabels[index];
    if (rawLabel === undefined || parsedLabel === undefined) {
      return false;
    }
    if (
      hasForbiddenRuntimeHostLabelChars(rawLabel) ||
      hasUnsafeUts46MappingChars(rawLabel) ||
      hasRuntimeIncompatibleNormalizedLabelText(rawLabel) ||
      hasRuntimeIncompatibleBidiLabel(rawLabel)
    ) {
      return false;
    }
    if (!/^[\x00-\x7f]*$/.test(rawLabel) && !parsedLabel.startsWith("xn--")) {
      return false;
    }
  }
  return true;
}

function diagnosticStaticBaseKey(base: string): string | null {
  if (
    hasDynamicBaseMarker(base) ||
    base.includes("\\") ||
    isAsciiSpaceOrControl(base)
  ) {
    return null;
  }

  const rawAuthority = rawUrlAuthority(base);
  const rawPath = rawUrlPath(base);
  if (
    rawAuthority === null ||
    rawPath === null ||
    rawAuthorityHasEmptyPort(rawAuthority)
  ) {
    return null;
  }

  const rawHostname = rawAuthorityHostname(rawAuthority);
  if (rawHostname === null) {
    return null;
  }

  try {
    const url = new URL(base);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      hostnameHasEmptyLabel(url.hostname.toLowerCase())
    ) {
      return null;
    }
    if (!runtimeCompatibleHostname(rawHostname, url.hostname)) {
      return null;
    }

    const host = stripHostnameTrailingDot(url.host.toLowerCase());
    const pathname = rawPath.replace(/\/+$/, "");
    return `${url.protocol}//${host}${pathname}`;
  } catch {
    return null;
  }
}

function connectorDiagnosticSharedBaseKeys(
  entries: readonly PythonBuiltinFirewallCatalogEntry[],
): ReadonlySet<string> {
  const connectorNamesByBase = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.diagnosticKind !== "connector") {
      continue;
    }
    for (const api of entry.firewall.apis) {
      const baseKey = diagnosticStaticBaseKey(api.base);
      if (
        baseKey === null ||
        extractDiagnosticReferenceNames(api.auth).length === 0
      ) {
        continue;
      }
      const connectorNames =
        connectorNamesByBase.get(baseKey) ?? new Set<string>();
      connectorNames.add(entry.firewall.name);
      connectorNamesByBase.set(baseKey, connectorNames);
    }
  }

  return new Set(
    [...connectorNamesByBase.entries()]
      .filter(([, connectorNames]) => {
        return connectorNames.size > 1;
      })
      .map(([base]) => {
        return base;
      }),
  );
}

function diagnosticConnectorApi(
  api: BuiltinFirewallRuntimeApi,
  sharedBaseKeys: ReadonlySet<string>,
): DiagnosticConnectorApi | null {
  const baseKey = diagnosticStaticBaseKey(api.base);
  if (baseKey === null) {
    return null;
  }

  const envNames = extractDiagnosticReferenceNames(api.auth);
  if (envNames.length === 0) {
    return null;
  }

  const permissions = sharedBaseKeys.has(baseKey)
    ? diagnosticPermissions(api.permissions)
    : [];

  return {
    base: api.base,
    envNames,
    authHeaderNames: diagnosticAuthHeaderNames(api.auth),
    authQueryParamNames: diagnosticAuthQueryParamNames(api.auth),
    ...(permissions.length > 0 ? { permissions } : {}),
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
  const sharedConnectorBaseKeys = connectorDiagnosticSharedBaseKeys(entries);

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
      .map((api) => {
        return diagnosticConnectorApi(api, sharedConnectorBaseKeys);
      })
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
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("unsupported JSON catalog array symbol key");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors)) {
      if (key === "length") {
        continue;
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined) {
        throw new Error(`missing JSON catalog array descriptor: ${key}`);
      }
      if (!isArrayIndexKey(key, value.length)) {
        throw new Error(`unsupported JSON catalog array property: ${key}`);
      }
      if (!isDataPropertyDescriptor(descriptor)) {
        throw new Error(
          `unsupported JSON catalog array accessor property: ${key}`,
        );
      }
      if (!descriptor.enumerable) {
        throw new Error(
          `unsupported JSON catalog array non-enumerable property: ${key}`,
        );
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new Error("unsupported sparse JSON catalog array");
      }
    }
    if (ancestors.has(value)) {
      throw new Error("unsupported circular JSON catalog value");
    }
    ancestors.add(value);
    try {
      const sorted: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !isDataPropertyDescriptor(descriptor)) {
          throw new Error(
            `missing JSON catalog array value descriptor: ${index}`,
          );
        }
        sorted.push(sortJson(descriptor.value, ancestors));
      }
      return sorted;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value !== "object") {
    throw new Error(`unsupported JSON catalog value: ${typeof value}`);
  }
  if (!isPlainJsonObject(value)) {
    const constructorName = objectConstructorName(value);
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
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (descriptor === undefined) {
        throw new Error(`missing JSON catalog object descriptor: ${key}`);
      }
      if (!isDataPropertyDescriptor(descriptor)) {
        throw new Error(
          `unsupported JSON catalog object accessor property: ${key}`,
        );
      }
      if (!descriptor.enumerable) {
        throw new Error(
          `unsupported JSON catalog object non-enumerable property: ${key}`,
        );
      }
      const nested = descriptor.value;
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
  const unsortedEntries = options.entries.map((entry) => {
    return {
      firewall: entry.firewall,
      diagnosticKind: entry.diagnosticKind,
    };
  });
  const jsonByFirewall = new Map<BuiltinFirewallRuntimeFirewall, string>();
  for (const entry of unsortedEntries) {
    jsonByFirewall.set(entry.firewall, stablePrettyJson(entry.firewall));
  }
  const entries = sortedUniqueEntries(unsortedEntries);
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

    const firewallJson = jsonByFirewall.get(firewall);
    if (firewallJson === undefined) {
      throw new Error(`missing Python JSON for firewall: ${firewall.name}`);
    }

    const chunks = splitJsonLines(firewallJson, maxJsonChunkLength);
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
