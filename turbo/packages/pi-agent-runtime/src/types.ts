/**
 * Published type surface of the Pi runtime.
 *
 * These declarations mirror the structural shapes that
 * `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` accept and
 * produce, instead of re-exporting their types. Consumers therefore never load
 * those packages' declaration graphs: apps/api's tsc program keeps ~240 MiB of
 * peak RSS that the re-exported surface used to cost.
 *
 * `src/index.ts` is the single place where the mirrors are assigned to and from
 * the native types, so any drift fails this package's own type check.
 */

import type { RunSkillSnapshotEntry } from "@vm0/api-contracts/contracts/runners";

/** Result of a fallible operation. Expected failures are returned as `ok: false` instead of thrown. */
export type Result<TValue, TError> =
  | { ok: true; value: TValue }
  | { ok: false; error: TError };

/** Kind of filesystem object as addressed by an {@link ExecutionEnv}. Symlinks are not followed automatically. */
export type FileKind = "file" | "directory" | "symlink";

/** Stable, backend-independent error codes returned by file operations. */
export type FileErrorCode =
  | "aborted"
  | "not_found"
  | "permission_denied"
  | "not_directory"
  | "is_directory"
  | "invalid"
  | "not_supported"
  | "unknown";

/** Stable, backend-independent error codes returned by {@link ExecutionEnv.exec}. */
export type ExecutionErrorCode =
  | "aborted"
  | "timeout"
  | "shell_unavailable"
  | "spawn_error"
  | "callback_error"
  | "unknown";

/** Error returned by file operations. */
export interface FileError extends Error {
  code: FileErrorCode;
  path?: string;
}

/** Constructor of {@link FileError}. */
export interface FileErrorConstructor {
  new (
    code: FileErrorCode,
    message: string,
    path?: string,
    cause?: Error,
  ): FileError;
}

/** Error returned by {@link ExecutionEnv.exec}. */
export interface ExecutionError extends Error {
  code: ExecutionErrorCode;
}

/** Constructor of {@link ExecutionError}. */
export interface ExecutionErrorConstructor {
  new (
    code: ExecutionErrorCode,
    message: string,
    cause?: Error,
  ): ExecutionError;
}

/** Metadata for one filesystem object. */
export interface FileInfo {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
}

/** Options for {@link ExecutionEnv.exec}. */
export interface ShellExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  timeout?: number;
  abortSignal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * Filesystem and process execution environment the Pi agent loop runs against.
 *
 * Operation methods must never throw or reject: every failure is encoded in the
 * returned {@link Result}.
 */
export interface ExecutionEnv {
  /** Current working directory for relative paths. */
  cwd: string;
  absolutePath(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>>;
  joinPath(
    parts: string[],
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>>;
  readTextFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>>;
  readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>>;
  readBinaryFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileError>>;
  writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>>;
  appendFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>>;
  fileInfo(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<FileInfo, FileError>>;
  listDir(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<FileInfo[], FileError>>;
  canonicalPath(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>>;
  exists(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<boolean, FileError>>;
  createDir(
    path: string,
    options?: { recursive?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>>;
  remove(
    path: string,
    options?: {
      recursive?: boolean;
      force?: boolean;
      abortSignal?: AbortSignal;
    },
  ): Promise<Result<void, FileError>>;
  createTempDir(
    prefix?: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>>;
  createTempFile(options?: {
    prefix?: string;
    suffix?: string;
    abortSignal?: AbortSignal;
  }): Promise<Result<string, FileError>>;
  exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<
    Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
  >;
  /** Release filesystem and shell resources. Best-effort; must not throw or reject. */
  cleanup(): Promise<void>;
}

/** Skill loaded from a `SKILL.md` file or provided by an application. */
export interface Skill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  disableModelInvocation?: boolean;
}

/** Stable diagnostic codes produced while loading skills. */
type SkillDiagnosticCode =
  | "file_info_failed"
  | "list_failed"
  | "read_failed"
  | "parse_failed"
  | "invalid_metadata";

/** Warning produced while loading skills. */
export interface SkillDiagnostic {
  type: "warning";
  code: SkillDiagnosticCode;
  message: string;
  path: string;
}

/** Text block of a Pi transcript message. */
interface PiTextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

/** Reasoning block of a Pi transcript message. */
interface PiThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

/** Image block of a Pi transcript message. */
interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** Tool call requested by the model. */
interface PiToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

/** Token accounting reported for one model turn. */
interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** Why a model turn stopped. */
type PiStopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted";

/** User turn in a Pi transcript. */
export interface PiUserMessage {
  role: "user";
  content: string | (PiTextContent | PiImageContent)[];
  timestamp: number;
}

/** Assistant turn in a Pi transcript. */
export interface PiAssistantMessage {
  role: "assistant";
  content: (PiTextContent | PiThinkingContent | PiToolCallContent)[];
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  usage: PiUsage;
  stopReason: PiStopReason;
  errorMessage?: string;
  rawStopReason?: string;
  timestamp: number;
}

/** Tool result turn in a Pi transcript. */
export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (PiTextContent | PiImageContent)[];
  details?: unknown;
  usage?: PiUsage;
  addedToolNames?: string[];
  isError: boolean;
  timestamp: number;
}

/** One persisted Pi transcript message. */
export type PiAgentMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage;

/** OpenAI-compatible providers Pi can drive. */
export const PI_OPENAI_COMPATIBLE_PROVIDERS = [
  "deepseek",
  "moonshotai",
  "openai",
  "openrouter",
  "vercel-ai-gateway",
  "codex",
] as const;

export type PiOpenAICompatibleProvider =
  (typeof PI_OPENAI_COMPATIBLE_PROVIDERS)[number];

/** Model endpoint and credential the Pi agent loop runs against. */
export interface PiAgentModelConfig {
  readonly provider: PiOpenAICompatibleProvider;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

/** Skills pinned by one run's snapshot, with their provenance. */
export interface PiRunSkills {
  readonly skills: readonly Skill[];
  readonly sourcedSkills: ReadonlyArray<{
    readonly skill: Skill;
    readonly source: RunSkillSnapshotEntry;
  }>;
  readonly diagnostics: ReadonlyArray<
    SkillDiagnostic & { readonly source: RunSkillSnapshotEntry }
  >;
}
