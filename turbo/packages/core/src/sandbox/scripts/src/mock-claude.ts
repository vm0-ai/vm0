/**
 * Mock Claude CLI for testing.
 * Executes prompt as bash and outputs Claude-compatible JSONL.
 *
 * Usage: mock-claude.mjs [options] <prompt>
 * The prompt is executed as a bash command.
 *
 * Special test prefixes:
 *   @fail:<message> - Output message to stderr and exit with code 1
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

export interface ParsedArgs {
  outputFormat: string;
  print: boolean;
  verbose: boolean;
  dangerouslySkipPermissions: boolean;
  resume: string | null;
  prompt: string;
}

/**
 * Parse command line arguments (same as real claude CLI).
 * Exported for testing.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    outputFormat: "text",
    print: false,
    verbose: false,
    dangerouslySkipPermissions: false,
    resume: null,
    prompt: "",
  };

  const remaining: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === "--output-format" && i + 1 < args.length) {
      result.outputFormat = args[i + 1] ?? "text";
      i += 2;
    } else if (arg === "--print") {
      result.print = true;
      i++;
    } else if (arg === "--verbose") {
      result.verbose = true;
      i++;
    } else if (arg === "--dangerously-skip-permissions") {
      result.dangerouslySkipPermissions = true;
      i++;
    } else if (arg === "--resume" && i + 1 < args.length) {
      result.resume = args[i + 1] ?? null;
      i += 2;
    } else if (arg) {
      remaining.push(arg);
      i++;
    } else {
      i++;
    }
  }

  // Get prompt from remaining args
  if (remaining.length > 0) {
    result.prompt = remaining[0] ?? "";
  }

  return result;
}

/**
 * Create session history file for checkpoint compatibility.
 * Claude Code stores session history at: ~/.claude/projects/-{path}/{session_id}.jsonl
 * Exported for testing.
 */
export function createSessionHistory(sessionId: string, cwd: string): string {
  const projectName = cwd.replace(/^\//, "").replace(/\//g, "-");
  const homeDir = process.env.HOME ?? "/home/user";
  const sessionDir = `${homeDir}/.claude/projects/-${projectName}`;
  fs.mkdirSync(sessionDir, { recursive: true });
  return path.join(sessionDir, `${sessionId}.jsonl`);
}

interface Event {
  type: string;
  subtype?: string;
  cwd?: string;
  session_id: string;
  tools?: string[];
  model?: string;
  message?: {
    role: string;
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: { command: string };
      tool_use_id?: string;
      content?: string;
      is_error?: boolean;
    }>;
  };
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * Main entry point for mock Claude.
 */
function main(): void {
  // Generate session ID
  const sessionId = `mock-${Date.now() * 1000 + Math.floor(Math.random() * 1000)}`;

  // Parse arguments
  const args = parseArgs(process.argv.slice(2));
  const prompt = args.prompt;
  const outputFormat = args.outputFormat;

  // Special test prefix: @fail:<message> - simulate Claude failure
  if (prompt.startsWith("@fail:")) {
    const errorMsg = prompt.slice(6); // Remove "@fail:" prefix
    console.error(errorMsg);
    process.exit(1);
  }

  // Get current working directory
  const cwd = process.cwd();

  if (outputFormat === "stream-json") {
    // Create session history file path
    const sessionHistoryFile = createSessionHistory(sessionId, cwd);

    const events: Event[] = [];

    // 1. System init event
    const initEvent: Event = {
      type: "system",
      subtype: "init",
      cwd,
      session_id: sessionId,
      tools: ["Bash"],
      model: "mock-claude",
    };
    console.log(JSON.stringify(initEvent));
    events.push(initEvent);

    // 2. Assistant text event
    const textEvent: Event = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Executing command..." }],
      },
      session_id: sessionId,
    };
    console.log(JSON.stringify(textEvent));
    events.push(textEvent);

    // 3. Assistant tool_use event
    const toolUseEvent: Event = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_mock_001",
            name: "Bash",
            input: { command: prompt },
          },
        ],
      },
      session_id: sessionId,
    };
    console.log(JSON.stringify(toolUseEvent));
    events.push(toolUseEvent);

    // 4. Execute prompt as bash and capture output
    let output: string;
    let exitCode: number;

    try {
      output = execSync(`bash -c ${JSON.stringify(prompt)}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      exitCode = 0;
    } catch (error) {
      const execError = error as {
        stdout?: string;
        stderr?: string;
        status?: number;
      };
      output = (execError.stdout ?? "") + (execError.stderr ?? "");
      exitCode = execError.status ?? 1;
    }

    // 5. User tool_result event
    const isError = exitCode !== 0;
    const toolResultEvent: Event = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_mock_001",
            content: output,
            is_error: isError,
          },
        ],
      },
      session_id: sessionId,
    };
    console.log(JSON.stringify(toolResultEvent));
    events.push(toolResultEvent);

    // 6. Result event
    const resultEvent: Event = {
      type: "result",
      subtype: exitCode === 0 ? "success" : "error",
      is_error: exitCode !== 0,
      duration_ms: 100,
      num_turns: 1,
      result: output,
      session_id: sessionId,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    console.log(JSON.stringify(resultEvent));
    events.push(resultEvent);

    // Write all events to session history file
    const historyContent =
      events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(sessionHistoryFile, historyContent);

    process.exit(exitCode);
  } else {
    // Plain text output - just execute the prompt
    try {
      execSync(`bash -c ${JSON.stringify(prompt)}`, {
        stdio: "inherit",
      });
      process.exit(0);
    } catch (error) {
      const execError = error as { status?: number };
      process.exit(execError.status ?? 1);
    }
  }
}

// Run main only when executed directly (not when imported for testing)
// In ESM, we check if this file is the entry point
const isMainModule =
  process.argv[1]?.endsWith("mock-claude.mjs") ||
  process.argv[1]?.endsWith("mock-claude.ts");

if (isMainModule) {
  main();
}
