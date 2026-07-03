import { stringify as stringifyYaml } from "yaml";

/**
 * Synthesize the SKILL.md written to a workflow's volume.
 *
 * The DB is the single source of truth for a workflow: its (name, description,
 * instruction) are composed into a SKILL.md whose frontmatter is generated, not
 * user-authored. Users never see or edit the frontmatter — they edit only the
 * instruction body and the supplementary files.
 */
export function synthesizeWorkflowSkillMd(args: {
  readonly name: string;
  readonly description: string | null;
  readonly instruction: string | null;
}): string {
  const frontmatter = stringifyYaml({
    name: args.name,
    // Claude Code requires a description; fall back to the slug.
    description: args.description ?? args.name,
  }).trimEnd();
  const body = (args.instruction ?? "").trim();
  return body.length > 0
    ? `---\n${frontmatter}\n---\n\n${body}\n`
    : `---\n${frontmatter}\n---\n`;
}

/**
 * Extract the instruction body from an existing SKILL.md by stripping a leading
 * YAML frontmatter block. Used to backfill the `instruction` column from
 * volumes authored before the DB became the source of truth.
 */
export function extractInstructionFromSkillMd(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const body = match ? content.slice(match[0].length) : content;
  return body.trim();
}
