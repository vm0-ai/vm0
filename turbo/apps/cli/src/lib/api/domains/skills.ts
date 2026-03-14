import { httpPost } from "../core/http";
import type { SkillFrontmatter } from "@vm0/core";
import chalk from "chalk";

interface ResolvedSkill {
  storageName: string;
  versionHash: string;
  frontmatter: SkillFrontmatter;
}

interface ResolveSkillsResponse {
  resolved: Record<string, ResolvedSkill>;
  unresolved: string[];
}

function isResolveSkillsResponse(
  value: unknown,
): value is ResolveSkillsResponse {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.resolved === "object" &&
    obj.resolved !== null &&
    Array.isArray(obj.unresolved)
  );
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
      console.error(
        chalk.dim("  Skill resolve unavailable, downloading all skills"),
      );
      return { resolved: {}, unresolved: skillUrls };
    }
    const body: unknown = await response.json();
    if (!isResolveSkillsResponse(body)) {
      console.error(
        chalk.dim(
          "  Skill resolve returned unexpected format, downloading all skills",
        ),
      );
      return { resolved: {}, unresolved: skillUrls };
    }
    return body;
  } catch {
    console.error(
      chalk.dim("  Skill resolve unavailable, downloading all skills"),
    );
    return { resolved: {}, unresolved: skillUrls };
  }
}
