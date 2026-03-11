import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

interface AgentMetadata {
  displayName?: string;
  sound?: string;
}

const METADATA_KEY_MAP: Record<string, string> = {
  displayName: "name",
  sound: "tone",
};

/**
 * Inject agent metadata into instructions content as YAML frontmatter.
 *
 * - If metadata is undefined/null or has no truthy fields, returns content unchanged.
 * - If content already has frontmatter, merges metadata fields into it.
 * - If no existing frontmatter, prepends a new frontmatter block.
 *
 * Key mapping: displayName → name, sound → tone
 */
export function injectMetadataFrontmatter(
  content: string,
  metadata?: AgentMetadata | null,
): string {
  if (!metadata) {
    return content;
  }

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value && METADATA_KEY_MAP[key]) {
      fields[METADATA_KEY_MAP[key]] = value;
    }
  }

  if (Object.keys(fields).length === 0) {
    return content;
  }

  const frontmatterMatch = content.match(
    /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/,
  );

  if (frontmatterMatch) {
    const existingYaml = frontmatterMatch[1] ?? "";
    const parsed = (parseYaml(existingYaml) ?? {}) as Record<string, unknown>;
    const merged = { ...parsed, ...fields };
    const newYaml = stringifyYaml(merged).trimEnd();
    const rest = content.slice(frontmatterMatch[0].length);
    return `---\n${newYaml}\n---\n${rest}`;
  }

  const yaml = stringifyYaml(fields).trimEnd();
  return `---\n${yaml}\n---\n\n${content}`;
}
