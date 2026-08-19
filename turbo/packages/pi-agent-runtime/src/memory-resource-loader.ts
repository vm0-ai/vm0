import { resolve } from "node:path";

import {
  createExtensionRuntime,
  createSyntheticSourceInfo,
  type PromptTemplate,
  type ReadOperations,
  type ResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";

export interface PiMemorySkillInput {
  readonly baseDir: string;
  readonly description: string;
  readonly disableModelInvocation?: boolean;
  readonly filePath: string;
  readonly name: string;
  readonly source?: string;
}

export interface PiMemoryResourceSnapshot {
  readonly agentsFiles: readonly {
    readonly content: string;
    readonly path: string;
  }[];
  readonly appendSystemPrompt?: readonly string[];
  readonly prompts?: readonly PromptTemplate[];
  readonly skills: readonly PiMemorySkillInput[];
  readonly systemPrompt?: string;
}

export interface PiMemoryFileInput {
  readonly content: Uint8Array;
  readonly path: string;
}

/**
 * Pi's stable ResourceLoader surface backed by an already-discovered snapshot.
 *
 * Discovery and validation should happen when the snapshot is produced. Runtime
 * construction only projects that result into Pi, so no temporary directory is
 * required and Pi still receives its native Skill and AGENTS.md shapes.
 */
export class PiMemoryResourceLoader implements ResourceLoader {
  readonly #agentsFiles: Array<{
    readonly content: string;
    readonly path: string;
  }>;
  readonly #appendSystemPrompt: string[];
  readonly #extensionResult = {
    errors: [],
    extensions: [],
    runtime: createExtensionRuntime(),
  };
  readonly #prompts: PromptTemplate[];
  readonly #skills: Skill[];
  readonly #systemPrompt: string | undefined;

  constructor(snapshot: PiMemoryResourceSnapshot) {
    this.#agentsFiles = snapshot.agentsFiles.map((file) => {
      return { ...file };
    });
    this.#appendSystemPrompt = [...(snapshot.appendSystemPrompt ?? [])];
    this.#prompts = [...(snapshot.prompts ?? [])];
    this.#skills = snapshot.skills.map((skill) => {
      return {
        baseDir: skill.baseDir,
        description: skill.description,
        disableModelInvocation: skill.disableModelInvocation ?? false,
        filePath: skill.filePath,
        name: skill.name,
        sourceInfo: createSyntheticSourceInfo(skill.filePath, {
          baseDir: skill.baseDir,
          scope: "user",
          source: skill.source ?? "vm0-memory",
        }),
      };
    });
    this.#systemPrompt = snapshot.systemPrompt;
  }

  getExtensions() {
    return this.#extensionResult;
  }

  getSkills() {
    return { diagnostics: [], skills: this.#skills };
  }

  getPrompts() {
    return { diagnostics: [], prompts: this.#prompts };
  }

  getThemes() {
    return { diagnostics: [], themes: [] };
  }

  getAgentsFiles() {
    return { agentsFiles: this.#agentsFiles };
  }

  getSystemPrompt(): string | undefined {
    return this.#systemPrompt;
  }

  getSystemPromptSource(): undefined {
    return undefined;
  }

  getAppendSystemPrompt(): string[] {
    return this.#appendSystemPrompt;
  }

  getAppendSystemPromptSources(): [] {
    return [];
  }

  extendResources(): void {
    // Executable extensions are intentionally disabled for the API memory path.
  }

  async reload(): Promise<void> {
    // The immutable snapshot is replaced as a unit by constructing a new loader.
  }
}

function missingFile(path: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such in-memory file, open '${path}'`);
  return Object.assign(error, { code: "ENOENT", path });
}

/** Read-only logical file namespace used by Pi's pluggable read operations. */
export class PiMemoryFileStore {
  readonly #files = new Map<string, Buffer>();

  constructor(files: readonly PiMemoryFileInput[]) {
    for (const file of files) {
      const path = resolve(file.path);
      if (this.#files.has(path)) {
        throw new Error(`Duplicate in-memory Pi file: ${path}`);
      }
      this.#files.set(
        path,
        Buffer.from(
          file.content.buffer as ArrayBuffer,
          file.content.byteOffset,
          file.content.byteLength,
        ),
      );
    }
  }

  has(path: string): boolean {
    return this.#files.has(resolve(path));
  }

  read(path: string): Buffer {
    const resolvedPath = resolve(path);
    const content = this.#files.get(resolvedPath);
    if (!content) {
      throw missingFile(resolvedPath);
    }
    return Buffer.from(content);
  }

  readOperations(): ReadOperations {
    return {
      access: async (path) => {
        if (!this.has(path)) {
          throw missingFile(resolve(path));
        }
      },
      detectImageMimeType: async () => {
        return null;
      },
      readFile: async (path) => {
        return this.read(path);
      },
    };
  }
}
