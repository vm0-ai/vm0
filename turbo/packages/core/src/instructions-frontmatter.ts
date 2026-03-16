interface AgentMetadata {
  displayName?: string;
  description?: string;
  sound?: string;
}

// Legacy HTML comment markers (for backward-compatible stripping)
const LEGACY_PROFILE_START = "<!-- ZERO_PROFILE";
const LEGACY_PROFILE_END = "ZERO_PROFILE -->";

// New plain-text markers visible to the agent at runtime
const PROFILE_START = "[AGENT_PROFILE]";
const PROFILE_END = "[/AGENT_PROFILE]";

/**
 * Remove all profile blocks (both legacy HTML comment and new plain-text
 * markers) from content in O(n) time.
 */
function stripMarkerBlocks(
  content: string,
  startMarker: string,
  endMarker: string,
): string {
  let result = "";
  let searchFrom = 0;

  while (searchFrom < content.length) {
    const startIdx = content.indexOf(startMarker + "\n", searchFrom);
    if (startIdx === -1) {
      result += content.slice(searchFrom);
      break;
    }

    result += content.slice(searchFrom, startIdx);

    const endIdx = content.indexOf(
      endMarker,
      startIdx + startMarker.length + 1,
    );
    if (endIdx === -1) {
      // No closing marker — keep the rest as-is
      result += content.slice(startIdx);
      break;
    }

    // Skip past the end marker and optional trailing newline
    let afterEnd = endIdx + endMarker.length;
    if (content[afterEnd] === "\n") {
      afterEnd++;
    }
    searchFrom = afterEnd;
  }

  return result;
}

function stripProfileBlocks(content: string): string {
  // Strip both legacy and new format
  const withoutLegacy = stripMarkerBlocks(
    content,
    LEGACY_PROFILE_START,
    LEGACY_PROFILE_END,
  );
  return stripMarkerBlocks(withoutLegacy, PROFILE_START, PROFILE_END);
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
 * Inject agent metadata into instructions content as a profile block.
 *
 * The block uses plain-text markers so it is fully visible to the agent
 * at runtime. It can be stripped before displaying in the instructions editor.
 *
 * Format:
 * ```
 * [AGENT_PROFILE]
 * Your name is Aria. Communicate in a clear, polished, and business-appropriate tone.
 * This should be reflected in all your responses.
 * [/AGENT_PROFILE]
 * ```
 *
 * - If metadata is undefined/null or has no truthy fields, returns content unchanged.
 * - If content already has a profile block, replaces it.
 * - Otherwise prepends it at the beginning.
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
  ).trimStart();

  if (!stripped) {
    return `${block}\n`;
  }

  return `${block}\n\n${stripped}`;
}

/**
 * Strip the profile block (and legacy YAML frontmatter) from
 * instructions content for display in the editor.
 */
export function stripMetadataFrontmatter(content: string): string {
  return stripProfileBlocks(stripLegacyFrontmatter(content)).trim();
}
