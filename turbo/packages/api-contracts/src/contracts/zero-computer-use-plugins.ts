import { z } from "zod";

export const COMPUTER_USE_PLUGIN_CALL_KIND = "plugin.call" as const;
export const COMPUTER_USE_FILESYSTEM_PLUGIN = "filesystem" as const;
export const COMPUTER_USE_FILESYSTEM_MCP_PACKAGE =
  "@modelcontextprotocol/server-filesystem" as const;
export const COMPUTER_USE_FILESYSTEM_MCP_VERSION = "2026.1.14" as const;

export const COMPUTER_USE_PLUGIN_RESULT_INLINE_TEXT_MAX_BYTES = 64 * 1024;
export const COMPUTER_USE_PLUGIN_RESULT_INLINE_JSON_MAX_BYTES = 256 * 1024;
export const COMPUTER_USE_PLUGIN_RESULT_BLOB_MAX_BYTES = 10 * 1024 * 1024;

export const computerUseFilesystemToolNames = [
  "list_allowed_directories",
  "read_text_file",
  "read_media_file",
  "read_multiple_files",
  "write_file",
  "edit_file",
  "create_directory",
  "list_directory",
  "list_directory_with_sizes",
  "directory_tree",
  "move_file",
  "search_files",
  "get_file_info",
] as const;

export type ComputerUseFilesystemTool =
  (typeof computerUseFilesystemToolNames)[number];

export const computerUseFilesystemToolSchema = z.enum(
  computerUseFilesystemToolNames,
);

export const computerUsePluginNameSchema = z.literal(
  COMPUTER_USE_FILESYSTEM_PLUGIN,
);

export type ComputerUsePluginName = z.infer<typeof computerUsePluginNameSchema>;

const pathArgumentSchema = z.string().trim().min(1).max(16_384);
const textContentSchema = z
  .string()
  .max(COMPUTER_USE_PLUGIN_RESULT_BLOB_MAX_BYTES);
const excludePatternsSchema = z.array(z.string().trim().min(1)).max(512);

const noArgumentsSchema = z.object({}).strict();

const readTextFileArgumentsSchema = z
  .object({
    path: pathArgumentSchema,
    tail: z.number().int().positive().optional(),
    head: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.head !== undefined && args.tail !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["head"],
        message: "read_text_file accepts either head or tail, not both",
      });
    }
  });

const readMediaFileArgumentsSchema = z
  .object({
    path: pathArgumentSchema,
  })
  .strict();

const readMultipleFilesArgumentsSchema = z
  .object({
    paths: z.array(pathArgumentSchema).min(1).max(100),
  })
  .strict();

const writeFileArgumentsSchema = z
  .object({
    path: pathArgumentSchema,
    content: textContentSchema,
  })
  .strict();

const editFileArgumentsSchema = z
  .object({
    path: pathArgumentSchema,
    edits: z
      .array(
        z
          .object({
            oldText: textContentSchema,
            newText: textContentSchema,
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
    dryRun: z.boolean().optional(),
  })
  .strict();

const createDirectoryArgumentsSchema = z
  .object({
    path: pathArgumentSchema,
  })
  .strict();

const listDirectoryArgumentsSchema = z
  .object({
    path: pathArgumentSchema,
  })
  .strict();

const listDirectoryWithSizesArgumentsSchema = z
  .object({
    path: pathArgumentSchema,
    sortBy: z.enum(["name", "size"]).optional(),
  })
  .strict();

const directoryTreeArgumentsSchema = z
  .object({
    path: pathArgumentSchema,
    excludePatterns: excludePatternsSchema.optional(),
  })
  .strict();

const moveFileArgumentsSchema = z
  .object({
    source: pathArgumentSchema,
    destination: pathArgumentSchema,
  })
  .strict();

const searchFilesArgumentsSchema = z
  .object({
    path: pathArgumentSchema,
    pattern: z.string().trim().min(1).max(4_096),
    excludePatterns: excludePatternsSchema.optional(),
  })
  .strict();

const getFileInfoArgumentsSchema = z
  .object({
    path: pathArgumentSchema,
  })
  .strict();

export function isComputerUseFilesystemTool(
  value: string,
): value is ComputerUseFilesystemTool {
  return computerUseFilesystemToolNames.some((tool) => {
    return tool === value;
  });
}

export function computerUseFilesystemToolArgumentsSchema(
  tool: ComputerUseFilesystemTool,
): z.ZodType<Record<string, unknown>> {
  switch (tool) {
    case "list_allowed_directories":
      return noArgumentsSchema;
    case "read_text_file":
      return readTextFileArgumentsSchema;
    case "read_media_file":
      return readMediaFileArgumentsSchema;
    case "read_multiple_files":
      return readMultipleFilesArgumentsSchema;
    case "write_file":
      return writeFileArgumentsSchema;
    case "edit_file":
      return editFileArgumentsSchema;
    case "create_directory":
      return createDirectoryArgumentsSchema;
    case "list_directory":
      return listDirectoryArgumentsSchema;
    case "list_directory_with_sizes":
      return listDirectoryWithSizesArgumentsSchema;
    case "directory_tree":
      return directoryTreeArgumentsSchema;
    case "move_file":
      return moveFileArgumentsSchema;
    case "search_files":
      return searchFilesArgumentsSchema;
    case "get_file_info":
      return getFileInfoArgumentsSchema;
  }
}

export function parseComputerUseFilesystemToolArguments(
  tool: ComputerUseFilesystemTool,
  args: unknown,
): Record<string, unknown> {
  return computerUseFilesystemToolArgumentsSchema(tool).parse(args);
}

export function computerUsePluginCapability(
  plugin: ComputerUsePluginName,
): string {
  return `plugin.${plugin}`;
}

export function computerUsePluginToolCapability(
  plugin: ComputerUsePluginName,
  tool: ComputerUseFilesystemTool,
): string {
  return `plugin.${plugin}.${tool}`;
}

export function computerUsePluginCallRequiredCapabilities(params: {
  readonly plugin: ComputerUsePluginName;
  readonly tool: ComputerUseFilesystemTool;
}): readonly string[] {
  return [
    COMPUTER_USE_PLUGIN_CALL_KIND,
    computerUsePluginCapability(params.plugin),
    computerUsePluginToolCapability(params.plugin, params.tool),
  ];
}

export function computerUseFilesystemToolIsDestructive(
  tool: ComputerUseFilesystemTool,
): boolean {
  return tool === "write_file" || tool === "edit_file" || tool === "move_file";
}

export const computerUsePluginCallBodySchema = z
  .object({
    plugin: computerUsePluginNameSchema,
    tool: computerUseFilesystemToolSchema,
    arguments: z.record(z.string(), z.unknown()).default({}),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(60_000),
  })
  .superRefine((body, ctx) => {
    const parsed = computerUseFilesystemToolArgumentsSchema(
      body.tool,
    ).safeParse(body.arguments);
    if (parsed.success) {
      return;
    }
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: "custom",
        path: ["arguments", ...issue.path],
        message: issue.message,
      });
    }
  });

export type ComputerUsePluginCallBody = z.infer<
  typeof computerUsePluginCallBodySchema
>;

export interface ComputerUsePluginCallPayload {
  readonly plugin: ComputerUsePluginName;
  readonly tool: ComputerUseFilesystemTool;
  readonly arguments: Record<string, unknown>;
}

export function isComputerUsePluginCallPayload(
  value: unknown,
): value is ComputerUsePluginCallPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const payload = value as {
    readonly plugin?: unknown;
    readonly tool?: unknown;
    readonly arguments?: unknown;
  };
  return (
    payload.plugin === COMPUTER_USE_FILESYSTEM_PLUGIN &&
    typeof payload.tool === "string" &&
    isComputerUseFilesystemTool(payload.tool) &&
    typeof payload.arguments === "object" &&
    payload.arguments !== null &&
    !Array.isArray(payload.arguments)
  );
}
