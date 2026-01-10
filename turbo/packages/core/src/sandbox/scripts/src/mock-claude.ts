/**
 * Mock Claude CLI for testing.
 * Executes prompt as bash and outputs Claude-compatible JSONL.
 *
 * Usage: mock-claude.js [options] <prompt>
 * The prompt is executed as a bash command.
 *
 * Special test prefixes:
 *   @fail:<message> - Output message to stderr and exit with code 1
 */
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

/**
 * Create session history file for checkpoint compatibility.
 * Claude Code stores session history at: ~/.claude/projects/-{path}/{session_id}.jsonl
 */
function createSessionHistory(sessionId: string, cwd: string): string {
  const projectName = cwd.replace(/^\//, "").replace(/\//g, "-");
  const homeDir = process.env.HOME ?? "/home/user";
  const sessionDir = `${homeDir}/.claude/projects/-${projectName}`;
  fs.mkdirSync(sessionDir, { recursive: true });
  return path.join(sessionDir, `${sessionId}.jsonl`);
}

interface ParsedArgs {
  outputFormat: string;
  print: boolean;
  verbose: boolean;
  dangerouslySkipPermissions: boolean;
  resume: string | null;
  prompt: string;
}

/**
 * Parse command line arguments (same as real claude CLI).
 */
function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const result: ParsedArgs = {
    outputFormat: "text",
    print: false,
    verbose: false,
    dangerouslySkipPermissions: false,
    resume: null,
    prompt: "",
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg) {
      i += 1;
      continue;
    }
    if (arg === "--output-format" && i + 1 < args.length) {
      result.outputFormat = args[i + 1] ?? "text";
      i += 2;
    } else if (arg === "--print") {
      result.print = true;
      i += 1;
    } else if (arg === "--verbose") {
      result.verbose = true;
      i += 1;
    } else if (arg === "--dangerously-skip-permissions") {
      result.dangerouslySkipPermissions = true;
      i += 1;
    } else if (arg === "--resume" && i + 1 < args.length) {
      result.resume = args[i + 1] ?? null;
      i += 2;
    } else if (!arg.startsWith("-")) {
      // First non-flag argument is the prompt
      result.prompt = arg;
      i += 1;
    } else {
      // Skip unknown flags
      i += 1;
    }
  }

  return result;
}

async function main(): Promise<void> {
  // Generate session ID
  const sessionId = `mock-${Date.now()}`;

  // Parse arguments
  const args = parseArgs();
  const prompt = args.prompt;
  const outputFormat = args.outputFormat;

  // Special test prefix: @fail:<message> - simulate Claude failure with stderr output
  // Usage: mock-claude "@fail:Session not found"
  // This outputs the message to stderr and exits with code 1
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

    const events: Record<string, unknown>[] = [];

    // 1. System init event
    const initEvent = {
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
    const textEvent = {
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
    const toolUseEvent = {
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
    let output = "";
    let exitCode = 0;

    try {
      const result = await new Promise<{
        stdout: string;
        stderr: string;
        code: number;
      }>((resolve) => {
        const proc = spawn("bash", ["-c", prompt], {
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        proc.on("close", (code) => {
          resolve({ stdout, stderr, code: code ?? 1 });
        });

        proc.on("error", (err) => {
          resolve({ stdout: "", stderr: err.message, code: 1 });
        });
      });

      output = result.stdout + result.stderr;
      exitCode = result.code;
    } catch (e) {
      output = String(e);
      exitCode = 1;
    }

    // 5. User tool_result event
    const isError = exitCode !== 0;
    const toolResultEvent = {
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
    const resultEvent = {
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
    const sessionContent =
      events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(sessionHistoryFile, sessionContent);

    process.exit(exitCode);
  } else {
    // Plain text output - just execute the prompt
    const proc = spawn("bash", ["-c", prompt], {
      stdio: "inherit",
    });

    proc.on("close", (code) => {
      process.exit(code ?? 1);
    });

    proc.on("error", (err) => {
      console.error(err.message);
      process.exit(1);
    });
  }
}

// Run main when executed directly
main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
