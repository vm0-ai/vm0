/**
 * Environment loader wrapper for VM0 runner.
 * Loads environment variables from JSON file before executing run-agent.mjs.
 *
 * This is needed because the runner passes environment variables via SCP (JSON file)
 * rather than directly setting them (which E2B sandbox API supports).
 */
import * as fs from "fs";
import { spawn } from "child_process";

// Environment JSON file path
const ENV_JSON_PATH = "/tmp/vm0-env.json";

console.log("[env-loader] Starting...");

// Load environment from JSON file
if (fs.existsSync(ENV_JSON_PATH)) {
  console.log(`[env-loader] Loading environment from ${ENV_JSON_PATH}`);
  try {
    const content = fs.readFileSync(ENV_JSON_PATH, "utf-8");
    const envData = JSON.parse(content) as Record<string, string>;
    for (const [key, value] of Object.entries(envData)) {
      process.env[key] = value;
    }
    console.log(
      `[env-loader] Loaded ${Object.keys(envData).length} environment variables`,
    );
  } catch (error) {
    console.error(`[env-loader] ERROR loading JSON: ${error}`);
    process.exit(1);
  }
} else {
  console.error(
    `[env-loader] ERROR: Environment file not found: ${ENV_JSON_PATH}`,
  );
  process.exit(1);
}

// Verify critical environment variables
const criticalVars = [
  "VM0_RUN_ID",
  "VM0_API_URL",
  "VM0_WORKING_DIR",
  "VM0_PROMPT",
];
for (const varName of criticalVars) {
  const val = process.env[varName] ?? "";
  if (val) {
    const display = val.length > 50 ? val.substring(0, 50) + "..." : val;
    console.log(`[env-loader] ${varName}=${display}`);
  } else {
    console.log(`[env-loader] WARNING: ${varName} is empty`);
  }
}

// Execute run-agent.mjs in a child process with inherited environment
const runAgentPath = "/usr/local/bin/vm0-agent/run-agent.mjs";
console.log(`[env-loader] Executing ${runAgentPath}`);

const child = spawn("node", [runAgentPath], {
  stdio: "inherit",
  env: process.env,
});

child.on("close", (code) => {
  process.exit(code ?? 1);
});
