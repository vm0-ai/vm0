type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

/**
 * Accepts the rich-input field emitted by the preceding API and returns only
 * the canonical current field. Remove after a current App can no longer meet
 * that API during rollout or rollback.
 */
export function normalizePrecedingStructuredPrompt(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const { structuredPrompt, ...canonical } = value;
  if ("userMessage" in canonical || structuredPrompt === undefined) {
    return canonical;
  }
  return { ...canonical, userMessage: structuredPrompt };
}

/** Canonicalizes the preceding API's persisted-draft response field. */
export function normalizePrecedingDraftStructuredPrompt(
  value: unknown,
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const { draftStructuredPrompt, ...canonical } = value;
  if ("draftUserMessage" in canonical || draftStructuredPrompt === undefined) {
    return canonical;
  }
  return { ...canonical, draftUserMessage: draftStructuredPrompt };
}

/**
 * Sends both wire names so independently promoted current and preceding APIs
 * each retain the rich input while their request validators ignore the other.
 */
export function withPrecedingStructuredPrompt<
  T extends { readonly userMessage?: unknown },
>(value: T): T & { readonly structuredPrompt?: T["userMessage"] } {
  if (value.userMessage === undefined) {
    return value;
  }
  return { ...value, structuredPrompt: value.userMessage };
}

/** Adds the preceding persisted-draft wire name for the rollout window. */
export function withPrecedingDraftStructuredPrompt<
  T extends { readonly draftUserMessage?: unknown },
>(
  value: T,
): T & {
  readonly draftStructuredPrompt?: T["draftUserMessage"];
} {
  if (value.draftUserMessage === undefined) {
    return value;
  }
  return { ...value, draftStructuredPrompt: value.draftUserMessage };
}
