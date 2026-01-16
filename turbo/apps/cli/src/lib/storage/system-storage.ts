import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseGitHubTreeUrl,
  downloadGitHubSkill,
  getSkillStorageName,
  getInstructionsStorageName,
  validateSkillDirectory,
  readSkillFrontmatter,
  type SkillFrontmatter,
} from "../domain/github-skills";
import { directUpload } from "./direct-upload";
import { getValidatedProvider } from "@vm0/core";

interface StorageUploadResult {
  name: string;
  versionId: string;
  action: "created" | "deduplicated";
}

/**
 * Result of uploading a skill, including parsed frontmatter
 */
export interface SkillUploadResult extends StorageUploadResult {
  skillName: string;
  frontmatter: SkillFrontmatter;
}

/**
 * Get the canonical instructions filename for a provider
 *
 * Each provider expects instructions at a specific filename:
 * - claude-code: CLAUDE.md (read from ~/.claude/)
 * - codex: AGENTS.md (read from ~/.codex/)
 *
 * @param provider - The provider name (e.g., "claude-code", "codex")
 * @returns The canonical filename for instructions
 * @throws Error if provider is defined but not supported
 */
export function getInstructionsFilename(provider?: string): string {
  const validatedProvider = getValidatedProvider(provider);
  if (validatedProvider === "codex") {
    return "AGENTS.md";
  }
  return "CLAUDE.md";
}

/**
 * Upload instructions file as a volume
 *
 * @param agentName - Name of the agent (used for storage name)
 * @param instructionsFilePath - Path to the instructions file (e.g., AGENTS.md)
 * @param basePath - Base path for resolving relative paths
 * @param provider - Provider name for determining canonical filename
 * @returns Upload result with storage name and version
 */
export async function uploadInstructions(
  agentName: string,
  instructionsFilePath: string,
  basePath: string,
  provider?: string,
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

  // Write file with provider-specific name (CLAUDE.md for claude-code, AGENTS.md for codex)
  const filename = getInstructionsFilename(provider);
  await fs.writeFile(path.join(instructionsDir, filename), content);

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
 * @returns Upload result with storage name, version, and parsed frontmatter
 */
export async function uploadSkill(
  skillUrl: string,
): Promise<SkillUploadResult> {
  const parsed = parseGitHubTreeUrl(skillUrl);
  const storageName = getSkillStorageName(parsed);

  // Create temp directory for download
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vm0-skill-"));

  try {
    // Download skill from GitHub
    const skillDir = await downloadGitHubSkill(parsed, tmpDir);

    // Validate the skill has SKILL.md
    await validateSkillDirectory(skillDir);

    // Parse frontmatter before upload
    const frontmatter = await readSkillFrontmatter(skillDir);

    // Use direct upload (bypasses Vercel 4.5MB limit)
    const result = await directUpload(storageName, "volume", skillDir);

    return {
      name: storageName,
      versionId: result.versionId,
      action: result.deduplicated ? "deduplicated" : "created",
      skillName: parsed.skillName,
      frontmatter,
    };
  } finally {
    // Clean up temp directory
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
