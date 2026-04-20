import { parse as parseYaml } from "yaml";

/**
 * Parsed skill frontmatter from SKILL.md
 */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

/**
 * Parse frontmatter from SKILL.md content.
 * Extracts YAML between --- markers at the start of the file.
 *
 * @param content - Raw content of SKILL.md file
 * @returns Parsed frontmatter fields
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) {
    return {};
  }

  const yamlContent = frontmatterMatch[1];
  if (!yamlContent) {
    return {};
  }

  const parsed: unknown = parseYaml(yamlContent);

  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  const data = parsed as Record<string, unknown>;

  return {
    name: typeof data.name === "string" ? data.name : undefined,
    description:
      typeof data.description === "string" ? data.description : undefined,
  };
}
