/**
 * GitHub codeload tarball download and extraction
 *
 * Downloads the vm0-skills repository tarball and extracts skill
 * directories in memory using the tar streaming parser.
 */

import { createHash } from "crypto";
import { gunzipSync } from "node:zlib";
import { Parser } from "tar";
import {
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
  DEFAULT_SKILLS_BRANCH,
} from "@vm0/core/github-url";

const TARBALL_URL = `https://codeload.github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tar.gz/refs/heads/${DEFAULT_SKILLS_BRANCH}`;

interface ExtractedFile {
  /** Relative path within skill directory (e.g., "SKILL.md") */
  path: string;
  content: Buffer;
  /** SHA-256 hash of file content */
  hash: string;
  size: number;
}

export interface ExtractedSkill {
  /** Directory name (e.g., "slack") */
  skillName: string;
  files: ExtractedFile[];
}

/**
 * Download the vm0-skills tarball and extract all skill directories.
 * Returns only directories that contain a SKILL.md file.
 */
export async function downloadAndExtractSkills(): Promise<ExtractedSkill[]> {
  const res = await fetch(TARBALL_URL);
  if (!res.ok) {
    throw new Error(`Failed to download tarball: ${res.status}`);
  }

  const compressed = Buffer.from(await res.arrayBuffer());
  return extractSkillsFromTarball(compressed);
}

/**
 * Extract skill directories from a gzipped tarball buffer.
 *
 * GitHub wraps tarball contents in a `{repo}-{branch}/` prefix directory.
 * Each subdirectory containing a SKILL.md is treated as a skill.
 */
function extractSkillsFromTarball(gzipped: Buffer): Promise<ExtractedSkill[]> {
  const decompressed = gunzipSync(gzipped);

  // Collect all files grouped by top-level skill directory
  const filesBySkill = new Map<string, ExtractedFile[]>();

  return new Promise((resolve, reject) => {
    const parser = new Parser({
      onReadEntry: (entry) => {
        if (entry.type !== "File") {
          entry.resume();
          return;
        }

        // Parse path: "{repo}-{branch}/{skillName}/..." → strip prefix
        const parts = entry.path.split("/");
        // parts[0] = "vm0-skills-main", parts[1] = skill dir, parts[2+] = file
        if (parts.length < 3) {
          entry.resume();
          return;
        }

        const skillName = parts[1]!;
        const relativePath = parts.slice(2).join("/");

        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => {
          return chunks.push(chunk);
        });
        entry.on("end", () => {
          const content = Buffer.concat(chunks);
          const hash = createHash("sha256").update(content).digest("hex");

          if (!filesBySkill.has(skillName)) {
            filesBySkill.set(skillName, []);
          }
          filesBySkill.get(skillName)!.push({
            path: relativePath,
            content,
            hash,
            size: content.length,
          });
        });
      },
    });

    parser.on("end", () => {
      // Only include directories that contain a SKILL.md file
      const skills: ExtractedSkill[] = [];
      for (const [skillName, files] of filesBySkill) {
        if (
          files.some((f) => {
            return f.path === "SKILL.md";
          })
        ) {
          skills.push({ skillName, files });
        }
      }
      resolve(skills);
    });

    parser.on("error", reject);

    // Feed decompressed tar data to parser
    parser.write(decompressed);
    parser.end();
  });
}
