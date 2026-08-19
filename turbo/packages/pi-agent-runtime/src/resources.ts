import { posix } from "node:path";

export interface PiSkillCatalogEntry {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly disableModelInvocation?: boolean;
}

export interface PiPreheatedAgentsFile {
  readonly path: string;
  readonly content: string;
}

export interface PiPreheatedResourceSnapshot {
  /** AGENTS.md contents are prompt input and therefore remain fully preheated. */
  readonly agentsFiles: readonly PiPreheatedAgentsFile[];
  /** Skill bodies stay outside the snapshot; discovery needs catalog metadata. */
  readonly skills: readonly PiSkillCatalogEntry[];
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Format Pi's native skill discovery block without reading any skill body. */
export function formatPiSkillCatalogForPrompt(args: {
  readonly skillRoot: string;
  readonly skills: readonly PiSkillCatalogEntry[];
}): string {
  const visibleSkills = args.skills.filter((skill) => {
    return !skill.disableModelInvocation;
  });
  if (visibleSkills.length === 0) {
    return "";
  }
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visibleSkills) {
    const location = posix.join(args.skillRoot, skill.slug, "SKILL.md");
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(
      `    <description>${escapeXml(skill.description)}</description>`,
    );
    lines.push(`    <location>${escapeXml(location)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
