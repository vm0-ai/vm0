import type {
  ChatMessageRecommendedFollowupGenerationType,
  ChatMessageRecommendedFollowups,
} from "@vm0/db/schema/chat-message";

export const RECOMMENDED_FOLLOWUP_LIMIT = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeFollowupPrompt(raw: string): string | null {
  const text = raw
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  if (text.length === 0) {
    return null;
  }
  return text.length > 120 ? `${text.slice(0, 117).trim()}...` : text;
}

function isRecommendedFollowupGenerationType(
  value: unknown,
): value is ChatMessageRecommendedFollowupGenerationType {
  return (
    value === "image" ||
    value === "video" ||
    value === "presentation" ||
    value === "website"
  );
}

function isJsonSyntaxPromptFragment(prompt: string): boolean {
  if (
    prompt === "[" ||
    prompt === "]" ||
    prompt === "{" ||
    prompt === "}" ||
    prompt === "]," ||
    prompt === "},"
  ) {
    return true;
  }

  return /^,?\s*(?:\[\s*)?(?:\{\s*)?"?(?:prompt|kind|generationType)"\s*:/.test(
    prompt,
  );
}

export function normalizeRecommendedFollowups(
  value: unknown,
): ChatMessageRecommendedFollowups {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const followups: ChatMessageRecommendedFollowups = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.prompt !== "string") {
      continue;
    }
    if (item.kind !== "talk" && item.kind !== "generate") {
      continue;
    }

    const prompt = sanitizeFollowupPrompt(item.prompt);
    if (
      prompt === null ||
      isJsonSyntaxPromptFragment(prompt) ||
      seen.has(prompt)
    ) {
      continue;
    }
    seen.add(prompt);

    followups.push({
      prompt,
      kind: item.kind,
      ...(item.kind === "generate" &&
      isRecommendedFollowupGenerationType(item.generationType)
        ? { generationType: item.generationType }
        : {}),
    });
    if (followups.length >= RECOMMENDED_FOLLOWUP_LIMIT) {
      break;
    }
  }

  return followups;
}
