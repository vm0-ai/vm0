interface AgentMetadata {
  displayName?: string;
  sound?: string;
}

const PROFILE_START = "<!-- ZERO_PROFILE";
const PROFILE_END = "ZERO_PROFILE -->";
const PROFILE_REGEX = /<!-- ZERO_PROFILE\n(?:[^\n]*\n)*?ZERO_PROFILE -->\n?/g;

/** Keys used by the legacy YAML frontmatter format. */
const LEGACY_METADATA_KEYS = new Set(["name", "tone"]);

/**
 * Strip legacy `---` YAML frontmatter that only contains our metadata keys
 * (name, tone). If user-defined keys exist, only our keys are removed.
 */
function stripLegacyFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) {
    return content;
  }
  const rawYaml = match[1] ?? "";
  const body = content.slice(match[0].length);

  const remaining = rawYaml
    .split("\n")
    .filter((line) => {
      const key = line.split(":")[0]?.trim();
      return !key || !LEGACY_METADATA_KEYS.has(key);
    })
    .join("\n")
    .trim();

  if (!remaining) {
    return body.replace(/^\n/, "");
  }
  return `---\n${remaining}\n---${body}`;
}

const TONE_DESCRIPTIONS: Record<string, string> = {
  professional: "clear, polished, and business-appropriate",
  friendly: "warm, approachable, and conversational",
  direct: "concise, to the point, and no-nonsense",
  supportive: "encouraging, empathetic, and reassuring",
};

function buildProfileParagraph(metadata: AgentMetadata): string | null {
  const parts: string[] = [];

  if (metadata.displayName) {
    parts.push(`Your name is ${metadata.displayName}.`);
  }

  if (metadata.sound) {
    const desc = TONE_DESCRIPTIONS[metadata.sound] ?? metadata.sound;
    parts.push(
      `Communicate in a ${desc} tone. This should be reflected in all your responses.`,
    );
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join(" ");
}

/**
 * Inject agent metadata into instructions content as a hidden profile block.
 *
 * The block uses HTML comment syntax so it can be stripped before displaying
 * in the instructions editor, while remaining readable to the agent at runtime.
 *
 * Format:
 * ```
 * <!-- ZERO_PROFILE
 * Your name is Aria. Communicate in a clear, polished, and business-appropriate tone.
 * This should be reflected in all your responses.
 * ZERO_PROFILE -->
 * ```
 *
 * - If metadata is undefined/null or has no truthy fields, returns content unchanged.
 * - If content already has a profile block, replaces it.
 * - Otherwise appends it at the end.
 */
export function injectMetadataFrontmatter(
  content: string,
  metadata?: AgentMetadata | null,
): string {
  if (!metadata) {
    return content;
  }

  const paragraph = buildProfileParagraph(metadata);
  if (!paragraph) {
    return content;
  }

  const block = `${PROFILE_START}\n${paragraph}\n${PROFILE_END}`;

  // Remove any existing profile block and legacy frontmatter first
  const stripped = stripLegacyFrontmatter(content)
    .replace(PROFILE_REGEX, "")
    .trimEnd();

  if (!stripped) {
    return `${block}\n`;
  }

  return `${stripped}\n\n${block}\n`;
}

/**
 * Strip the hidden profile block (and legacy YAML frontmatter) from
 * instructions content for display in the editor.
 */
export function stripMetadataFrontmatter(content: string): string {
  return stripLegacyFrontmatter(content).replace(PROFILE_REGEX, "").trim();
}
