import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseGitHubTreeUrl,
  downloadGitHubSkill,
  getSkillStorageName,
  getInstructionsStorageName,
  validateSkillDirectory,
} from "./github-skills";
import { directUpload } from "./direct-upload";

export interface StorageUploadResult {
  name: string;
  versionId: string;
  action: "created" | "deduplicated";
}

/**
 * Upload instructions file as a volume
 *
 * @param agentName - Name of the agent (used for storage name)
 * @param instructionsFilePath - Path to the instructions file (e.g., AGENTS.md)
 * @param basePath - Base path for resolving relative paths
 * @returns Upload result with storage name and version
 */
export async function uploadInstructions(
  agentName: string,
  instructionsFilePath: string,
  basePath: string,
): Promise<StorageUploadResult> {
  const storageName = getInstructionsStorageName(agentName);

  // Resolve file path relative to base path
  const absolutePath = path.isAbsolute(instructionsFilePath)
    ? instructionsFilePath
    : path.join(basePath, instructionsFilePath);

  // Read the instructions file
  const content = await fs.readFile(absolutePath, "utf8");

  // Create a temporary directory with the file
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vm0-instructions-"));
  const instructionsDir = path.join(tmpDir, "instructions");
  await fs.mkdir(instructionsDir);

  // Write file as CLAUDE.md (the canonical name for Claude Code instructions)
  await fs.writeFile(path.join(instructionsDir, "CLAUDE.md"), content);

  try {
    // Use direct upload (bypasses Vercel 4.5MB limit)
    const result = await directUpload(storageName, "volume", instructionsDir);

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
export async function uploadSkill(
  skillUrl: string,
): Promise<StorageUploadResult> {
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
