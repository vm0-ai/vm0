import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";

const CONFIG_DIR = join(homedir(), ".vm0");
const COOK_STATE_FILE = join(CONFIG_DIR, "cook.json");

export interface CookState {
  lastRunId?: string;
  lastSessionId?: string;
  lastCheckpointId?: string;
}

export async function loadCookState(): Promise<CookState> {
  if (!existsSync(COOK_STATE_FILE)) {
    return {};
  }
  try {
    const content = await readFile(COOK_STATE_FILE, "utf8");
    return JSON.parse(content) as CookState;
  } catch {
    // If file is corrupted, return empty state
    return {};
  }
}

export async function saveCookState(state: CookState): Promise<void> {
  // Ensure config directory exists
  await mkdir(CONFIG_DIR, { recursive: true });

  // Merge with existing state
  const existing = await loadCookState();
  const merged = { ...existing, ...state };

  // Write state file
  await writeFile(COOK_STATE_FILE, JSON.stringify(merged, null, 2), "utf8");
}
