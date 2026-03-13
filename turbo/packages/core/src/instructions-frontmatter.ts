interface AgentMetadata {
  displayName?: string;
  description?: string;
  sound?: string;
}

const PROFILE_START = "<!-- ZERO_PROFILE";
const PROFILE_END = "ZERO_PROFILE -->";

/**
 * Remove all ZERO_PROFILE blocks from content in O(n) time.
 * Uses indexOf instead of regex to avoid ReDoS with nested/repeated markers.
 */
function stripProfileBlocks(content: string): string {
  let result = "";
  let searchFrom = 0;

  while (searchFrom < content.length) {
    const startIdx = content.indexOf(PROFILE_START + "\n", searchFrom);
    if (startIdx === -1) {
      result += content.slice(searchFrom);
      break;
    }

    result += content.slice(searchFrom, startIdx);

    const endIdx = content.indexOf(
      PROFILE_END,
      startIdx + PROFILE_START.length + 1,
    );
    if (endIdx === -1) {
      // No closing marker — keep the rest as-is
      result += content.slice(startIdx);
      break;
    }

    // Skip past the end marker and optional trailing newline
    let afterEnd = endIdx + PROFILE_END.length;
    if (content[afterEnd] === "\n") {
      afterEnd++;
    }
    searchFrom = afterEnd;
  }

  return result;
}

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

  if (metadata.description) {
    parts.push(metadata.description);
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
  const stripped = stripProfileBlocks(
    stripLegacyFrontmatter(content),
  ).trimEnd();

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
  return stripProfileBlocks(stripLegacyFrontmatter(content)).trim();
}
