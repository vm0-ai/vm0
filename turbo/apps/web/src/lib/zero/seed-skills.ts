import { resolveSkillRef } from "@vm0/core/github-url";
import { SEED_SKILLS } from "@vm0/core/zero-seed-skills";
import type { skills } from "@vm0/db/schema/skill";

export { SEED_SKILLS };

/**
 * Build skill insert values from a list of skill names.
 * Shared by dev-seed and test helpers to avoid duplicated URL/frontmatter construction.
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
