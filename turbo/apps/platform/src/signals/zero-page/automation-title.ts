const AUTOMATION_TITLE_EXCERPT_MAX = 30;

interface AutomationTitleInput {
  readonly description?: string | null;
  readonly prompt: string;
  readonly name?: string | null;
}

function excerptText(text: string, maxLen: number): string {
  const t = text.trim();
  if (t.length <= maxLen) {
    return t;
  }
  return `${t.slice(0, maxLen - 1)}\u2026`;
}

function firstSentenceFromInstruction(text: string): string {
  const t = text.trim();
  if (t.length === 0) {
    return "";
  }
  const match = t.match(/^[\s\S]*?(?:[。！？]|[.!?](?:\s|$))/);
  if (match) {
    return match[0].trim();
  }
  return t.split(/\r?\n/)[0]?.trim() ?? t;
}

export function automationTitle(entry: AutomationTitleInput): string {
  const desc = entry.description?.trim();
  if (desc && desc.length > 0) {
    return desc;
  }

  const promptTrim = entry.prompt.trim();
  if (promptTrim.length > 0) {
    const first = firstSentenceFromInstruction(promptTrim);
    return first.length > 0 ? first : promptTrim;
  }

  const name = entry.name?.trim();
  if (name && name.length > 0) {
    return name;
  }

  return "Automation";
}

export function automationTitleExcerpt(
  entry: AutomationTitleInput,
  maxLen = AUTOMATION_TITLE_EXCERPT_MAX,
): string {
  return excerptText(automationTitle(entry), maxLen);
}
