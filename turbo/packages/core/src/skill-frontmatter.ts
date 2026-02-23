import { parse as parseYaml } from "yaml";

/**
 * Parsed skill frontmatter from SKILL.md
 */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  vm0_secrets?: string[];
  vm0_vars?: string[];
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

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  const data = parsed as Record<string, unknown>;

  return {
    name: typeof data.name === "string" ? data.name : undefined,
    description:
      typeof data.description === "string" ? data.description : undefined,
    vm0_secrets: Array.isArray(data.vm0_secrets)
      ? data.vm0_secrets.filter((s): s is string => typeof s === "string")
      : undefined,
    vm0_vars: Array.isArray(data.vm0_vars)
      ? data.vm0_vars.filter((s): s is string => typeof s === "string")
      : undefined,
  };
}

/**
 * Sync skill-declared environment variables with an agent's environment.
 *
 * - Adds `${{ secrets.X }}` / `${{ vars.X }}` entries for skill-declared vars
 *   that are missing from the environment.
 * - Removes entries that were previously added by skills (detected by the
 *   self-referencing template pattern `KEY = ${{ secrets.KEY }}`) but are no
 *   longer declared by any current skill.
 *
 * @param skills - Array of skill GitHub tree URLs
 * @param environment - Current agent environment (mutated in place)
 */
export async function mergeSkillEnvironment(
  skills: string[],
  environment: Record<string, string>,
): Promise<void> {
  const skillDeclared = await collectSkillDeclaredVars(skills);

  // Remove stale skill-added entries that are no longer declared by any skill.
  // Skill-added entries have a self-referencing template pattern:
  //   KEY = "${{ secrets.KEY }}" or KEY = "${{ vars.KEY }}"
  for (const key of Object.keys(environment)) {
    const value = environment[key];
    const isSkillAdded =
      value === `\${{ secrets.${key} }}` || value === `\${{ vars.${key} }}`;
    if (isSkillAdded && !skillDeclared.has(key)) {
      delete environment[key];
    }
  }

  // Add missing entries for current skills
  for (const [name, source] of skillDeclared) {
    if (!(name in environment)) {
      environment[name] =
        source === "secret"
          ? `\${{ secrets.${name} }}`
          : `\${{ vars.${name} }}`;
    }
  }
}

/**
 * Collect all env var names declared by the given skills.
 * Returns a map of name → "secret" | "var".
 */
async function collectSkillDeclaredVars(
  skills: string[],
): Promise<Map<string, "secret" | "var">> {
  const declared = new Map<string, "secret" | "var">();
  const results = await Promise.allSettled(
    skills.map((url) => fetchSkillMdContent(url)),
  );

  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value) {
      continue;
    }
    const fm = parseSkillFrontmatter(result.value);
    if (fm.vm0_secrets) {
      for (const name of fm.vm0_secrets) {
        declared.set(name, "secret");
      }
    }
    if (fm.vm0_vars) {
      for (const name of fm.vm0_vars) {
        declared.set(name, "var");
      }
    }
  }

  return declared;
}

/**
 * Build the raw GitHub URL for a skill's SKILL.md file.
 */
function buildSkillMdUrl(url: string): string | null {
  const match = url
    .replace(/\/+$/, "")
    .match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/);
  if (!match) {
    return null;
  }
  const [, owner, repo, branch, path] = match;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}/SKILL.md`;
}

/**
 * Fetch the raw SKILL.md content from a GitHub skill URL.
 * Returns null if the URL is invalid or the fetch fails.
 */
async function fetchSkillMdContent(skillUrl: string): Promise<string | null> {
  const rawUrl = buildSkillMdUrl(skillUrl);
  if (!rawUrl) {
    return null;
  }
  const res = await fetch(rawUrl);
  if (!res.ok) {
    return null;
  }
  return res.text();
}

/**
 * Fetch and parse SKILL.md frontmatter from a GitHub skill URL.
 * Returns null if the URL is invalid or the fetch fails.
 */
export async function fetchSkillFrontmatter(
  skillUrl: string,
): Promise<SkillFrontmatter | null> {
  const content = await fetchSkillMdContent(skillUrl);
  if (!content) {
    return null;
  }
  return parseSkillFrontmatter(content);
}
