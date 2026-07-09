import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  COMPUTER_USE_PLUGIN_RESULT_BLOB_MAX_BYTES,
  COMPUTER_USE_PLUGIN_RESULT_INLINE_TEXT_MAX_BYTES,
} from "@vm0/api-contracts/contracts/zero-computer-use-plugins";
import type {
  ComputerUseCommandExecutionResult,
  ComputerUseCommandFailure,
} from "./computer-use-accessibility";

const TEXT_MIME_TYPE = "text/plain; charset=utf-8";
const DEFAULT_FILENAME = "plugin-result.txt";

/**
 * Identifies the plugin call a normalized result belongs to. `server` is set
 * for MCP plugin calls only; `mapErrorCode` lets a plugin map server error
 * messages to a more specific failure code than `mcp_error`.
 */
interface PluginToolResultContext {
  readonly plugin: string;
  readonly tool: string;
  readonly server?: string;
  readonly mapErrorCode?: (
    message: string,
  ) => ComputerUseCommandFailure["error"]["code"];
}

export function commandFailure(
  code: ComputerUseCommandFailure["error"]["code"],
  message: string,
): ComputerUseCommandExecutionResult {
  return { status: "failed", error: { code, message } };
}

export function pluginErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bufferByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function resultTooLarge(sizeBytes: number): ComputerUseCommandExecutionResult {
  return commandFailure(
    "result_too_large",
    `Plugin result is ${sizeBytes} bytes and exceeds the ${COMPUTER_USE_PLUGIN_RESULT_BLOB_MAX_BYTES} byte limit.`,
  );
}

function resultBase(context: PluginToolResultContext): Record<string, unknown> {
  return {
    plugin: context.plugin,
    ...(context.server ? { server: context.server } : {}),
    tool: context.tool,
  };
}

function filenameForTool(context: PluginToolResultContext): string {
  const safeTool = context.tool.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safeTool}.txt`;
}

function pluginContentResult(
  context: PluginToolResultContext,
  args: {
    readonly text?: string;
    readonly dataBase64?: string;
    readonly mimeType: string;
    readonly fileName: string;
    readonly sizeBytes: number;
  },
): ComputerUseCommandExecutionResult {
  if (args.sizeBytes > COMPUTER_USE_PLUGIN_RESULT_BLOB_MAX_BYTES) {
    return resultTooLarge(args.sizeBytes);
  }
  return {
    status: "succeeded",
    result: {
      ...resultBase(context),
      sizeBytes: args.sizeBytes,
      offloaded: true,
      ...(args.text ? { summary: `Saved ${args.sizeBytes} bytes` } : {}),
      pluginContent: {
        dataBase64:
          args.dataBase64 ??
          Buffer.from(args.text ?? "", "utf8").toString("base64"),
        mimeType: args.mimeType,
        fileName: args.fileName,
      },
    },
  };
}

function pluginTextResult(
  context: PluginToolResultContext,
  text: string,
): ComputerUseCommandExecutionResult {
  const sizeBytes = bufferByteLength(text);
  if (sizeBytes <= COMPUTER_USE_PLUGIN_RESULT_INLINE_TEXT_MAX_BYTES) {
    return {
      status: "succeeded",
      result: {
        ...resultBase(context),
        content: text,
        sizeBytes,
        truncated: false,
      },
    };
  }
  return pluginContentResult(context, {
    text,
    mimeType: TEXT_MIME_TYPE,
    fileName: filenameForTool(context),
    sizeBytes,
  });
}

export function pluginJsonResult(
  context: PluginToolResultContext,
  value: unknown,
): ComputerUseCommandExecutionResult {
  return pluginTextResult(context, `${JSON.stringify(value, null, 2)}\n`);
}

export function normalizePluginToolResult(
  context: PluginToolResultContext,
  result: CallToolResult,
): ComputerUseCommandExecutionResult {
  if (result.isError) {
    const message = result.content
      .map((entry) => {
        return entry.type === "text" ? entry.text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    return commandFailure(
      context.mapErrorCode?.(message) ?? "mcp_error",
      message || `Plugin tool ${context.tool} failed`,
    );
  }

  const textEntries = result.content.filter((entry) => {
    return entry.type === "text";
  });
  if (textEntries.length === result.content.length) {
    return pluginTextResult(
      context,
      textEntries
        .map((entry) => {
          return entry.text;
        })
        .join("\n"),
    );
  }

  const firstBinary = result.content.find((entry) => {
    return entry.type === "image" || entry.type === "audio";
  });
  if (firstBinary?.type === "image" || firstBinary?.type === "audio") {
    const sizeBytes = Buffer.from(firstBinary.data, "base64").length;
    return pluginContentResult(context, {
      dataBase64: firstBinary.data,
      mimeType: firstBinary.mimeType,
      fileName: DEFAULT_FILENAME,
      sizeBytes,
    });
  }

  const firstResource = result.content.find((entry) => {
    return entry.type === "resource";
  });
  if (firstResource?.type === "resource") {
    const resource = firstResource.resource;
    const fileName = path.basename(resource.uri) || DEFAULT_FILENAME;
    if ("text" in resource) {
      return pluginContentResult(context, {
        text: resource.text,
        mimeType: resource.mimeType ?? TEXT_MIME_TYPE,
        fileName,
        sizeBytes: bufferByteLength(resource.text),
      });
    }
    const sizeBytes = Buffer.from(resource.blob, "base64").length;
    return pluginContentResult(context, {
      dataBase64: resource.blob,
      mimeType: resource.mimeType ?? "application/octet-stream",
      fileName,
      sizeBytes,
    });
  }

  return pluginJsonResult(context, result.content);
}
