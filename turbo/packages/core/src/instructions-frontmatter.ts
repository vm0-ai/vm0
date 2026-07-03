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

/**
 * Strip the profile block (and legacy YAML frontmatter) from
 * instructions content for display in the editor.
 *
 * Kept for transition: existing S3 archives may still have baked-in
 * `[AGENT_PROFILE]` blocks from before metadata was moved to the
 * `zero_agents` table. Once all instructions have been re-uploaded
 * without the block, this function can be removed entirely.
 */
export function stripMetadataFrontmatter(content: string): string {
  return stripProfileBlocks(stripLegacyFrontmatter(content)).trim();
}
