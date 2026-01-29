import { mkdir, writeFile } from "fs/promises";
import path from "path";
import chalk from "chalk";

// Skill definitions
interface SkillDefinition {
  name: string;
  dir: string;
  url: string;
}

// Define skills as a tuple to ensure type safety
const VM0_CLI_SKILL: SkillDefinition = {
  name: "vm0-cli",
  dir: ".claude/skills/vm0-cli",
  url: "https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/vm0-cli/SKILL.md",
};

const VM0_AGENT_SKILL: SkillDefinition = {
  name: "vm0-agent",
  dir: ".claude/skills/vm0-agent",
  url: "https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/vm0-agent/SKILL.md",
};

export const SKILLS: readonly [SkillDefinition, SkillDefinition] = [
  VM0_CLI_SKILL,
  VM0_AGENT_SKILL,
];

// Primary skill for user prompt (vm0-agent)
export const PRIMARY_SKILL_NAME = "vm0-agent";

// Legacy exports for backward compatibility
export const SKILL_DIR = VM0_CLI_SKILL.dir;
export const SKILL_FILE = "SKILL.md";
export const SKILL_NAME = VM0_CLI_SKILL.name;

// Default URL for legacy fetchSkillContent
const DEFAULT_SKILL_URL = VM0_CLI_SKILL.url;

/**
 * Handle fetch error with user-friendly message and exit
 */
export function handleFetchError(error: unknown, url?: string): never {
  const displayUrl = url ?? "GitHub";
  console.error(chalk.red(`Failed to fetch skill from ${displayUrl}`));
  if (error instanceof Error) {
    console.error(chalk.red(error.message));
  }
  console.error(chalk.dim("Please check your network connection."));
  process.exit(1);
}

/**
 * Fetch skill content from a URL
 * @throws Error if fetch fails
 */
export async function fetchSkillContent(url?: string): Promise<string> {
  const fetchUrl = url ?? DEFAULT_SKILL_URL;
  const response = await fetch(fetchUrl);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch skill from ${fetchUrl}: ${response.status} ${response.statusText}`,
    );
  }

  return response.text();
}

interface InstallSkillResult {
  skillDir: string;
  skillFile: string;
}

interface InstallAllSkillsResult {
  skills: InstallSkillResult[];
}

/**
 * Install a single skill in the specified directory
 */
async function installSingleSkill(
  skill: SkillDefinition,
  targetDir: string,
): Promise<InstallSkillResult> {
  const skillDirPath = path.join(targetDir, skill.dir);
  const skillFilePath = path.join(skillDirPath, SKILL_FILE);

  const content = await fetchSkillContent(skill.url);

  await mkdir(skillDirPath, { recursive: true });
  await writeFile(skillFilePath, content);

  return {
    skillDir: skillDirPath,
    skillFile: skillFilePath,
  };
}

/**
 * Install the vm0-cli skill in the specified directory (legacy function)
 * @param targetDir - Base directory to install the skill in (defaults to current directory)
 * @throws Error if fetch fails or file operations fail
 */
export async function installClaudeSkill(
  targetDir: string = process.cwd(),
): Promise<InstallSkillResult> {
  return installSingleSkill(VM0_CLI_SKILL, targetDir);
}

/**
 * Install all Claude skills in the specified directory
 * @param targetDir - Base directory to install skills in (defaults to current directory)
 * @throws Error if fetch fails or file operations fail
 */
export async function installAllClaudeSkills(
  targetDir: string = process.cwd(),
): Promise<InstallAllSkillsResult> {
  const results: InstallSkillResult[] = [];

  for (const skill of SKILLS) {
    const result = await installSingleSkill(skill, targetDir);
    results.push(result);
  }

  return { skills: results };
}
