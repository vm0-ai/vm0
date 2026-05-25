import { resolveSkillRef } from "@vm0/core/github-url";
import type { skills } from "@vm0/db/schema/skill";

/**
 * Build skill insert values from a list of skill names.
 * Shared by web test setup and DB-direct seeders.
 */
export function buildSeedSkillValues(
  names: readonly string[],
): (typeof skills.$inferInsert)[] {
  return names.map((name) => {
    const url = resolveSkillRef(name);
    const fullPath = url.replace("https://github.com/", "");
    return {
      url,
      name,
      fullPath,
      versionHash: null,
      frontmatter: {
        name,
        description: `${name} skill`,
      },
    };
  });
}
