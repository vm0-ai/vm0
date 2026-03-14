import { httpPost } from "../core/http";
import type { SkillFrontmatter } from "@vm0/core";

interface ResolvedSkill {
  storageName: string;
  versionHash: string;
  frontmatter: SkillFrontmatter;
}

interface ResolveSkillsResponse {
  resolved: Record<string, ResolvedSkill>;
  unresolved: string[];
}

/**
 * Batch-resolve skill URLs against the server's skill cache.
 * Returns resolved skills (cached) and unresolved skills (need download).
 * Gracefully degrades: any error returns all skills as unresolved.
 */
export async function resolveSkills(
  skillUrls: string[],
): Promise<ResolveSkillsResponse> {
  try {
    const response = await httpPost("/api/skills/resolve", {
      skills: skillUrls,
    });
    if (!response.ok) {
      return { resolved: {}, unresolved: skillUrls };
    }
    return (await response.json()) as ResolveSkillsResponse;
  } catch {
    return { resolved: {}, unresolved: skillUrls };
  }
}
