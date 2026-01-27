import { Command } from "commander";
import chalk from "chalk";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

const SKILL_DIR = ".claude/skills/vm0-agent-builder";
const GITHUB_API_URL =
  "https://api.github.com/repos/vm0-ai/vm0/contents/docs/vm0-agent-builder";
const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/vm0-ai/vm0/main/docs/vm0-agent-builder";

interface GitHubContent {
  name: string;
  type: "file" | "dir";
  download_url: string | null;
}

async function downloadSkillFromGitHub(): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  // Get directory listing from GitHub API
  const response = await fetch(GITHUB_API_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch skill listing: ${response.statusText}`);
  }

  const contents = (await response.json()) as GitHubContent[];

  // Download each file
  for (const item of contents) {
    if (item.type === "file") {
      const fileResponse = await fetch(`${GITHUB_RAW_URL}/${item.name}`);
      if (!fileResponse.ok) {
        throw new Error(
          `Failed to download ${item.name}: ${fileResponse.statusText}`,
        );
      }
      const content = await fileResponse.text();
      files.set(item.name, content);
    }
  }

  return files;
}

export const setupClaudeCommand = new Command()
  .name("setup-claude")
  .description("Add/update Claude skill for agent building")
  .action(async () => {
    console.log(chalk.dim("Downloading vm0-agent-builder skill..."));

    const files = await downloadSkillFromGitHub();

    if (files.size === 0) {
      console.error(chalk.red("x No skill files found"));
      process.exit(1);
    }

    // Create directory
    await mkdir(SKILL_DIR, { recursive: true });

    // Write files
    for (const [filename, content] of files) {
      await writeFile(path.join(SKILL_DIR, filename), content);
    }

    console.log(
      chalk.green(`Done Installed vm0-agent-builder skill to ${SKILL_DIR}`),
    );
    console.log();
    console.log("Next step:");
    console.log(
      chalk.cyan(
        '  claude /vm0-agent-builder "I want to build an agent that..."',
      ),
    );
  });
