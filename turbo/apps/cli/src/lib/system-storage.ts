import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseGitHubTreeUrl,
  downloadGitHubSkill,
  getSkillStorageName,
  getSystemPromptStorageName,
  validateSkillDirectory,
} from "./github-skills";
import { directUpload } from "./direct-upload";

export interface SystemStorageUploadResult {
  name: string;
  versionId: string;
  action: "created" | "deduplicated";
}

/**
 * Upload system prompt file as a volume
 *
 * @param agentName - Name of the agent (used for storage name)
 * @param promptFilePath - Path to the system prompt file (AGENTS.md)
 * @param basePath - Base path for resolving relative paths
 * @returns Upload result with storage name and version
 */
export async function uploadSystemPrompt(
  agentName: string,
  promptFilePath: string,
  basePath: string,
): Promise<SystemStorageUploadResult> {
  const storageName = getSystemPromptStorageName(agentName);

  // Resolve file path relative to base path
  const absolutePath = path.isAbsolute(promptFilePath)
    ? promptFilePath
    : path.join(basePath, promptFilePath);

  // Read the prompt file
  const content = await fs.readFile(absolutePath, "utf8");

  // Create a temporary directory with the file
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vm0-prompt-"));
  const promptDir = path.join(tmpDir, "prompt");
  await fs.mkdir(promptDir);

  // Write file as CLAUDE.md (the canonical name for Claude Code system prompts)
  await fs.writeFile(path.join(promptDir, "CLAUDE.md"), content);

  try {
    // Use direct upload (bypasses Vercel 4.5MB limit)
    const result = await directUpload(storageName, "volume", promptDir);

    return {
      name: storageName,
      versionId: result.versionId,
      action: result.deduplicated ? "deduplicated" : "created",
    };
  } finally {
    // Clean up temp directory
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Upload a skill from GitHub as a volume
 *
 * @param skillUrl - GitHub tree URL for the skill
 * @returns Upload result with storage name and version
 */
export async function uploadSystemSkill(
  skillUrl: string,
): Promise<SystemStorageUploadResult> {
  const parsed = parseGitHubTreeUrl(skillUrl);
  const storageName = getSkillStorageName(parsed);

  // Create temp directory for download
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vm0-skill-"));

  try {
    // Download skill from GitHub
    const skillDir = await downloadGitHubSkill(parsed, tmpDir);

    // Validate the skill has SKILL.md
    await validateSkillDirectory(skillDir);

    // Use direct upload (bypasses Vercel 4.5MB limit)
    const result = await directUpload(storageName, "volume", skillDir);

    return {
      name: storageName,
      versionId: result.versionId,
      action: result.deduplicated ? "deduplicated" : "created",
    };
  } finally {
    // Clean up temp directory
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
