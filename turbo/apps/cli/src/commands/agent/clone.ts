import { Command } from "commander";
import chalk from "chalk";
import { mkdtempSync } from "fs";
import { mkdir, writeFile, readdir, copyFile, rm } from "fs/promises";
import { checkDirectoryStatus } from "../../lib/utils/file-utils";
import { join, dirname } from "path";
import { tmpdir } from "os";
import * as tar from "tar";
import { stringify as yamlStringify } from "yaml";
import { getComposeByName, getStorageDownload } from "../../lib/api";
import { getInstructionsStorageName } from "@vm0/core";
import type { AgentComposeContent } from "../../lib/domain/compose-types";

/**
 * Remove deprecated fields from compose content
 */
function cleanComposeContent(
  content: AgentComposeContent,
): AgentComposeContent {
  const cleaned: AgentComposeContent = {
    version: content.version,
    agents: {},
  };

  for (const [agentName, agent] of Object.entries(content.agents)) {
    // Destructure to exclude deprecated fields
    const { image, working_dir: workingDir, ...rest } = agent;
    void image;
    void workingDir;
    cleaned.agents[agentName] = rest;
  }

  // Keep volumes section if it exists
  if (content.volumes) {
    cleaned.volumes = content.volumes;
  }

  return cleaned;
}

/**
 * Download instructions volume and extract to destination
 */
async function downloadInstructions(
  agentName: string,
  instructionsPath: string,
  destination: string,
): Promise<boolean> {
  const volumeName = getInstructionsStorageName(agentName);

  console.log(chalk.dim("Downloading instructions..."));

  const downloadInfo = await getStorageDownload({
    name: volumeName,
    type: "volume",
  });

  if ("empty" in downloadInfo) {
    console.log(chalk.yellow("⚠ Instructions volume is empty"));
    return false;
  }

  // Download tar.gz from S3
  const response = await fetch(downloadInfo.url);
  if (!response.ok) {
    throw new Error(`Failed to download instructions: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Extract to temp directory
  const tmpDir = mkdtempSync(join(tmpdir(), "vm0-clone-"));
  const tarPath = join(tmpDir, "archive.tar.gz");

  await writeFile(tarPath, buffer);
  await tar.extract({ file: tarPath, cwd: tmpDir, gzip: true });

  // Find the extracted markdown file (CLAUDE.md or AGENTS.md)
  const files = await readdir(tmpDir);
  const mdFile = files.find((f) => f === "CLAUDE.md" || f === "AGENTS.md");

  if (!mdFile) {
    console.log(chalk.yellow("⚠ No instructions file found in volume"));
    await rm(tmpDir, { recursive: true, force: true });
    return false;
  }

  // Determine destination path (preserve original path from YAML)
  const destPath = join(destination, instructionsPath);
  await mkdir(dirname(destPath), { recursive: true });

  // Copy file to destination with original filename
  await copyFile(join(tmpDir, mdFile), destPath);

  // Cleanup temp directory
  await rm(tmpDir, { recursive: true, force: true });

  return true;
}

export const cloneCommand = new Command()
  .name("clone")
  .description("Clone agent compose to local directory (latest version)")
  .argument("<name>", "Agent compose name to clone")
  .argument("[destination]", "Destination directory (default: agent name)")
  .action(async (name: string, destination: string | undefined) => {
    try {
      const targetDir = destination || name;

      // Check if destination already exists and is non-empty
      const dirStatus = checkDirectoryStatus(targetDir);
      if (dirStatus.exists && !dirStatus.empty) {
        console.error(chalk.red(`✗ Directory "${targetDir}" is not empty`));
        process.exit(1);
      }

      console.log(`Cloning agent compose: ${name}`);

      // Fetch compose from API
      const compose = await getComposeByName(name);

      if (!compose) {
        console.error(chalk.red(`✗ Agent compose not found: ${name}`));
        process.exit(1);
      }

      if (!compose.content || !compose.headVersionId) {
        console.error(chalk.red(`✗ Agent compose has no content: ${name}`));
        process.exit(1);
      }

      const content = compose.content as AgentComposeContent;

      // Clean up deprecated fields
      const cleanedContent = cleanComposeContent(content);

      // Convert to YAML
      const yamlContent = yamlStringify(cleanedContent);

      // Create destination directory
      await mkdir(targetDir, { recursive: true });

      // Write vm0.yaml
      const yamlPath = join(targetDir, "vm0.yaml");
      await writeFile(yamlPath, yamlContent, "utf8");
      console.log(chalk.green("✓ Created vm0.yaml"));

      // Download instructions if present
      const agentKey = Object.keys(content.agents)[0];
      const agent = agentKey ? content.agents[agentKey] : undefined;

      if (agent?.instructions) {
        try {
          const instructionsDownloaded = await downloadInstructions(
            name,
            agent.instructions,
            targetDir,
          );
          if (instructionsDownloaded) {
            console.log(chalk.green(`✓ Downloaded ${agent.instructions}`));
          }
        } catch (error) {
          // Non-fatal: warn but continue
          console.log(
            chalk.yellow(
              `⚠ Could not download instructions: ${error instanceof Error ? error.message : "Unknown error"}`,
            ),
          );
        }
      }

      // Success output
      console.log();
      console.log(chalk.green(`✓ Successfully cloned agent: ${name}`));
      console.log(chalk.dim(`  Location: ${targetDir}/`));
      console.log(chalk.dim(`  Version: ${compose.headVersionId.slice(0, 8)}`));
    } catch (error) {
      console.error(chalk.red("✗ Clone failed"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
