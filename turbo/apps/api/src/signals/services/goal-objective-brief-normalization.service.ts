const OBJECTIVE_BRIEF_MAX_CHARS = 140;
const DEFAULT_GOAL_OBJECTIVE_BRIEF = "Untitled goal";

function stripMarkdown(text: string): string {
  return text
    .replace(/(\*{1,3}|_{1,3})(.+?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^["'](.+)["']$/, "$1")
    .trim();
}

export function compactGoalObjectiveBriefText(text: string): string {
  return stripMarkdown(text).replace(/\s+/g, " ").trim();
}

export function capGoalObjectiveBriefText(text: string): string {
  const maxTextChars = OBJECTIVE_BRIEF_MAX_CHARS - 3;
  let endIndex = 0;
  let charCount = 0;
  for (const char of text) {
    if (charCount === OBJECTIVE_BRIEF_MAX_CHARS) {
      return `${text.slice(0, endIndex).trimEnd()}...`;
    }
    if (charCount < maxTextChars) {
      endIndex += char.length;
    }
    charCount += 1;
  }
  return text;
}

export function fallbackGoalObjectiveBrief(objective: string): string {
  const firstNonEmptyLine = objective
    .split(/\r?\n/)
    .map((line) => {
      return compactGoalObjectiveBriefText(line);
    })
    .find((line) => {
      return line.length > 0;
    });
  const rawFirstNonEmptyLine = objective
    .split(/\r?\n/)
    .map((line) => {
      return line.trim();
    })
    .find((line) => {
      return line.length > 0;
    });
  const compactObjective = compactGoalObjectiveBriefText(objective);
  const fallback =
    firstNonEmptyLine ??
    (compactObjective.length > 0 ? compactObjective : undefined) ??
    rawFirstNonEmptyLine ??
    DEFAULT_GOAL_OBJECTIVE_BRIEF;
  return capGoalObjectiveBriefText(fallback);
}

export function nonEmptyGoalObjectiveBrief(
  objectiveBrief: string | null | undefined,
): string {
  const trimmed = objectiveBrief?.trim() ?? "";
  return trimmed.length > 0
    ? capGoalObjectiveBriefText(trimmed)
    : DEFAULT_GOAL_OBJECTIVE_BRIEF;
}

export function normalizeGoalObjectiveBrief(args: {
  readonly objective: string;
  readonly objectiveBrief: string;
}): string {
  const trimmed = args.objectiveBrief.trim();
  return trimmed.length > 0
    ? capGoalObjectiveBriefText(trimmed)
    : fallbackGoalObjectiveBrief(args.objective);
}
