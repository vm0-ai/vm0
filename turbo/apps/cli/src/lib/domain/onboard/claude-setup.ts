import { mkdir, writeFile } from "fs/promises";
import path from "path";

export const SKILL_DIR = ".claude/skills/vm0-cli";
export const SKILL_FILE = "SKILL.md";
export const SKILL_NAME = "vm0-cli";
export const SKILL_URL =
  "https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/vm0-cli/SKILL.md";

/**
 * Fetch the vm0-cli skill content from GitHub
 * @throws Error if fetch fails
 */
export async function fetchSkillContent(): Promise<string> {
  const response = await fetch(SKILL_URL);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch skill from ${SKILL_URL}: ${response.status} ${response.statusText}`,
    );
  }

  return response.text();
}

interface InstallSkillResult {
  skillDir: string;
  skillFile: string;
}

/**
 * Install the vm0-cli skill in the specified directory
 * @param targetDir - Base directory to install the skill in (defaults to current directory)
 * @throws Error if fetch fails or file operations fail
 */
export async function installClaudeSkill(
  targetDir: string = process.cwd(),
): Promise<InstallSkillResult> {
  const skillDirPath = path.join(targetDir, SKILL_DIR);
  const skillFilePath = path.join(skillDirPath, SKILL_FILE);

  const content = await fetchSkillContent();

  await mkdir(skillDirPath, { recursive: true });
  await writeFile(skillFilePath, content);

  return {
    skillDir: skillDirPath,
    skillFile: skillFilePath,
  };
}
