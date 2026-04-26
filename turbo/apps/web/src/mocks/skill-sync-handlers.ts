/**
 * Shared test utilities for skill sync mock data.
 *
 * Provides tarball generation and seed skill name constants used by
 * sync-skills tests and the vitest globalSetup.
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";
import {
  DEFAULT_SKILLS_REPO,
  DEFAULT_SKILLS_BRANCH,
} from "@vm0/core/github-url";
import { getEligibleConnectorTypes } from "@vm0/connectors/connector-utils";
import { SEED_SKILLS } from "../lib/zero/seed-skills";

/** All skill names that buildComposeContent would reference. */
export const ALL_SEED_SKILL_NAMES: readonly string[] = [
  ...new Set([...SEED_SKILLS, ...getEligibleConnectorTypes()]),
];

interface MockSkillEntry {
  name: string;
  files: Array<{ path: string; content: string }>;
}

/**
 * Build a gzipped tarball buffer containing mock skills.
 * Mimics the GitHub codeload format with a `{repo}-{branch}/` prefix.
 */
export function createMockTarball(mockSkills: MockSkillEntry[]): Buffer {
  const tmpDir = mkdtempSync(join(tmpdir(), "vm0-test-tarball-"));
  const prefix = `${DEFAULT_SKILLS_REPO}-${DEFAULT_SKILLS_BRANCH}`;

  try {
    mkdirSync(join(tmpDir, prefix), { recursive: true });

    const filePaths: string[] = [];
    for (const skill of mockSkills) {
      const skillDir = join(tmpDir, prefix, skill.name);
      mkdirSync(skillDir, { recursive: true });

      for (const file of skill.files) {
        const filePath = join(skillDir, file.path);
        mkdirSync(join(filePath, ".."), { recursive: true });
        writeFileSync(filePath, file.content);
        filePaths.push(join(prefix, skill.name, file.path));
      }
    }

    const tarPath = join(tmpDir, "test.tar.gz");
    tar.create(
      { gzip: true, file: tarPath, cwd: tmpDir, sync: true },
      filePaths,
    );
    return readFileSync(tarPath);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
