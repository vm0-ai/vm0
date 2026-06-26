// Shared presentational helpers for the workflow list, index, and detail views.
import type {
  GmailLabelAppliedEventConfig,
  GmailNewMessageEventConfig,
  ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";

export function workflowTitle(workflow: {
  readonly name: string;
  readonly displayName: string | null;
}): string {
  return workflow.displayName ?? workflow.name;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

export function agentLabel(workflow: {
  readonly agentDisplayName: string | null;
  readonly agentName: string | null;
  readonly agentId: string;
}): string {
  return workflow.agentDisplayName ?? workflow.agentName ?? workflow.agentId;
}

export function triggerKindLabel(trigger: ZeroWorkflowTriggerSummary): string {
  if (trigger.kind === "schedule") {
    return "Schedule trigger";
  }
  return trigger.eventType === "webhook-received"
    ? "Webhook trigger"
    : "Event trigger";
}

type GmailMatchRules = NonNullable<GmailNewMessageEventConfig["match"]>;
type GmailTextMatcher = NonNullable<GmailMatchRules["from"]>;
export type GmailTextField = "from" | "subject" | "body" | "to" | "cc";

export const GMAIL_TEXT_FIELDS: readonly {
  readonly field: GmailTextField;
  readonly label: string;
}[] = [
  { field: "from", label: "From" },
  { field: "subject", label: "Subject" },
  { field: "body", label: "Body" },
  { field: "to", label: "To" },
  { field: "cc", label: "Cc" },
];

function formTextValue(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildGmailNewMessageEventConfig(
  form: FormData,
  baseConfig?: GmailNewMessageEventConfig,
): GmailNewMessageEventConfig {
  const baseMatch = baseConfig?.match;
  const match: GmailMatchRules = {};
  for (const { field } of GMAIL_TEXT_FIELDS) {
    const existing = baseMatch?.[field];
    const contains = formTextValue(form, `${field}Contains`);
    const doesNotContain = formTextValue(form, `${field}DoesNotContain`);
    const matcher: GmailTextMatcher = {};
    if (existing?.containsAny) {
      matcher.containsAny = existing.containsAny;
    }
    if (existing?.doesNotContainAny) {
      matcher.doesNotContainAny = existing.doesNotContainAny;
    }
    if (contains) {
      matcher.contains = contains;
    }
    if (doesNotContain) {
      matcher.doesNotContain = doesNotContain;
    }
    if (Object.keys(matcher).length > 0) {
      match[field] = matcher;
    }
  }
  return Object.keys(match).length > 0
    ? { provider: "gmail", event: "new_message", match }
    : { provider: "gmail", event: "new_message" };
}

export function buildGmailLabelAppliedEventConfig(
  form: FormData,
): GmailLabelAppliedEventConfig | null {
  const labelName = formTextValue(form, "labelName");
  if (!labelName) {
    return null;
  }
  return {
    provider: "gmail",
    event: "label_applied",
    labelName,
  };
}

function quote(value: string): string {
  return `"${value}"`;
}

function quoteList(values: readonly string[]): string {
  return values.map(quote).join(", ");
}

function textMatcherParts(
  field: GmailTextField,
  matcher: GmailTextMatcher,
): string[] {
  const parts: string[] = [];
  if (matcher.contains) {
    parts.push(`${field} contains ${quote(matcher.contains)}`);
  }
  if (matcher.containsAny) {
    parts.push(`${field} contains any of ${quoteList(matcher.containsAny)}`);
  }
  if (matcher.doesNotContain) {
    parts.push(`${field} does not contain ${quote(matcher.doesNotContain)}`);
  }
  if (matcher.doesNotContainAny) {
    parts.push(
      `${field} does not contain any of ${quoteList(matcher.doesNotContainAny)}`,
    );
  }
  return parts;
}

export function formatGmailMatchSummary(
  config: GmailNewMessageEventConfig,
): string {
  const match = config.match;
  if (!match) {
    return "all inbound messages";
  }

  const parts: string[] = [];
  for (const { field } of GMAIL_TEXT_FIELDS) {
    const matcher = match[field];
    if (matcher) {
      parts.push(...textMatcherParts(field, matcher));
    }
  }
  return parts.length > 0 ? parts.join("; ") : "all inbound messages";
}

export function gmailTriggerTitle(trigger: ZeroWorkflowTriggerSummary): string {
  if (trigger.kind === "schedule") {
    return trigger.scheduleSummary;
  }
  return trigger.eventType === "gmail-label-applied"
    ? "Gmail label applied"
    : "Gmail new message";
}

export function gmailTriggerSummary(
  trigger: ZeroWorkflowTriggerSummary,
): string | null {
  if (trigger.kind !== "event") {
    return null;
  }
  if (trigger.eventType === "gmail-label-applied") {
    return `Label ${quote(trigger.eventConfig.labelName)}`;
  }
  if (trigger.eventType === "gmail-new-message") {
    return formatGmailMatchSummary(trigger.eventConfig);
  }
  return null;
}

export function gmailMatcherDefaultValue(
  config: GmailNewMessageEventConfig,
  field: GmailTextField,
  key: "contains" | "doesNotContain",
): string {
  return config.match?.[field]?.[key] ?? "";
}
