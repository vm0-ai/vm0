import { readFileSync } from "node:fs";
import type {
  GmailLabelAppliedEventConfig,
  GmailNewMessageEventConfig,
} from "@vm0/api-contracts/contracts/zero-workflows";

type GmailMatchRules = NonNullable<GmailNewMessageEventConfig["match"]>;
type GmailTextMatcher = NonNullable<GmailMatchRules["from"]>;
type GmailTextField = "from" | "subject" | "body" | "to" | "cc";

export interface GmailTriggerOptions {
  readonly config?: string;
  readonly label?: string;
  readonly fromContains?: string;
  readonly fromNotContains?: string;
  readonly subjectContains?: string;
  readonly subjectNotContains?: string;
  readonly bodyContains?: string;
  readonly bodyNotContains?: string;
  readonly toContains?: string;
  readonly toNotContains?: string;
  readonly ccContains?: string;
  readonly ccNotContains?: string;
}

interface TextFlagSpec {
  readonly field: GmailTextField;
  readonly contains?: string;
  readonly doesNotContain?: string;
}

const TEXT_FIELD_LABELS: Record<GmailTextField, string> = {
  from: "from",
  subject: "subject",
  body: "body",
  to: "to",
  cc: "cc",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFieldFromKey(key: string): GmailTextField | null {
  switch (key) {
    case "from":
    case "subject":
    case "body":
    case "to":
    case "cc":
      return key;
    default:
      return null;
  }
}

function formatFieldName(field: GmailTextField): string {
  return TEXT_FIELD_LABELS[field];
}

function parseNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function parseNonEmptyStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty string array`);
  }
  return value.map((item, index) => {
    return parseNonEmptyString(item, `${path}[${index}]`);
  });
}

function parseTextMatcher(
  field: GmailTextField,
  value: unknown,
): GmailTextMatcher {
  if (!isRecord(value)) {
    throw new Error(`${formatFieldName(field)} must be an object`);
  }

  const matcher: {
    contains?: string;
    containsAny?: string[];
    doesNotContain?: string;
    doesNotContainAny?: string[];
  } = {};

  for (const key of Object.keys(value)) {
    switch (key) {
      case "contains":
        matcher.contains = parseNonEmptyString(
          value[key],
          `${formatFieldName(field)}.contains`,
        );
        break;
      case "containsAny":
        matcher.containsAny = parseNonEmptyStringArray(
          value[key],
          `${formatFieldName(field)}.containsAny`,
        );
        break;
      case "doesNotContain":
        matcher.doesNotContain = parseNonEmptyString(
          value[key],
          `${formatFieldName(field)}.doesNotContain`,
        );
        break;
      case "doesNotContainAny":
        matcher.doesNotContainAny = parseNonEmptyStringArray(
          value[key],
          `${formatFieldName(field)}.doesNotContainAny`,
        );
        break;
      default:
        throw new Error(
          `Unsupported Gmail trigger text matcher "${key}" for ${formatFieldName(field)}`,
        );
    }
  }

  if (
    matcher.contains === undefined &&
    matcher.containsAny === undefined &&
    matcher.doesNotContain === undefined &&
    matcher.doesNotContainAny === undefined
  ) {
    throw new Error(
      `${formatFieldName(field)} must include at least one text matcher`,
    );
  }

  return matcher;
}

function parseMatch(value: unknown): GmailMatchRules | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("match must be an object");
  }

  const match: GmailMatchRules = {};
  for (const key of Object.keys(value)) {
    const field = textFieldFromKey(key);
    if (field === null) {
      throw new Error(
        `Unsupported Gmail trigger match field "${key}". Supported fields: from, subject, body, to, cc`,
      );
    }
    match[field] = parseTextMatcher(field, value[key]);
  }

  return Object.keys(match).length > 0 ? match : undefined;
}

function readConfigMatch(path: string): GmailMatchRules | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to read Gmail trigger config "${path}": ${message}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("Gmail trigger config must be a JSON object");
  }

  for (const key of Object.keys(parsed)) {
    if (key !== "match") {
      throw new Error(
        `Unsupported Gmail trigger config field "${key}". Use a top-level match object`,
      );
    }
  }

  return parseMatch(parsed.match);
}

function textFlagSpecs(options: GmailTriggerOptions): readonly TextFlagSpec[] {
  return [
    {
      field: "from",
      contains: options.fromContains,
      doesNotContain: options.fromNotContains,
    },
    {
      field: "subject",
      contains: options.subjectContains,
      doesNotContain: options.subjectNotContains,
    },
    {
      field: "body",
      contains: options.bodyContains,
      doesNotContain: options.bodyNotContains,
    },
    {
      field: "to",
      contains: options.toContains,
      doesNotContain: options.toNotContains,
    },
    {
      field: "cc",
      contains: options.ccContains,
      doesNotContain: options.ccNotContains,
    },
  ];
}

export function hasGmailTriggerOptions(options: GmailTriggerOptions): boolean {
  return (
    options.config !== undefined ||
    textFlagSpecs(options).some((spec) => {
      return spec.contains !== undefined || spec.doesNotContain !== undefined;
    })
  );
}

export function hasGmailLabelOption(options: GmailTriggerOptions): boolean {
  return options.label !== undefined;
}

function buildMatchFromFlags(
  options: GmailTriggerOptions,
): GmailMatchRules | undefined {
  const match: GmailMatchRules = {};
  for (const spec of textFlagSpecs(options)) {
    const matcher: { contains?: string; doesNotContain?: string } = {};
    if (spec.contains !== undefined) {
      if (spec.contains.length === 0) {
        throw new Error(
          `${formatFieldName(spec.field)} contains must be non-empty`,
        );
      }
      matcher.contains = spec.contains;
    }
    if (spec.doesNotContain !== undefined) {
      if (spec.doesNotContain.length === 0) {
        throw new Error(
          `${formatFieldName(spec.field)} doesNotContain must be non-empty`,
        );
      }
      matcher.doesNotContain = spec.doesNotContain;
    }
    if (
      matcher.contains !== undefined ||
      matcher.doesNotContain !== undefined
    ) {
      match[spec.field] = matcher;
    }
  }
  return Object.keys(match).length > 0 ? match : undefined;
}

export function buildGmailNewMessageEventConfig(
  options: GmailTriggerOptions,
): GmailNewMessageEventConfig {
  if (
    options.config !== undefined &&
    textFlagSpecs(options).some((spec) => {
      return spec.contains !== undefined || spec.doesNotContain !== undefined;
    })
  ) {
    throw new Error("Use either --config or Gmail text match flags, not both");
  }

  const match =
    options.config !== undefined
      ? readConfigMatch(options.config)
      : buildMatchFromFlags(options);

  return match
    ? { provider: "gmail", event: "new_message", match }
    : { provider: "gmail", event: "new_message" };
}

export function buildGmailLabelAppliedEventConfig(
  options: GmailTriggerOptions,
): GmailLabelAppliedEventConfig {
  const labelName = options.label?.trim();
  if (!labelName) {
    throw new Error(
      'gmail-label-applied triggers require --label "Label name"',
    );
  }
  return { provider: "gmail", event: "label_applied", labelName };
}
