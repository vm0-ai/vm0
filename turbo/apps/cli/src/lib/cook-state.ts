import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";

const CONFIG_DIR = join(homedir(), ".vm0");
const COOK_STATE_FILE = join(CONFIG_DIR, "cook.json");
const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

// Public API interface (unchanged for backward compatibility)
export interface CookState {
  lastRunId?: string;
  lastSessionId?: string;
  lastCheckpointId?: string;
}

// Internal storage structure
interface CookStateEntry {
  lastRunId?: string;
  lastSessionId?: string;
  lastCheckpointId?: string;
  lastActiveAt: number;
}

interface CookStateFile {
  ppid: Record<string, CookStateEntry>;
}

/**
 * Load cook state file with automatic migration from old format
 */
async function loadCookStateFile(): Promise<CookStateFile> {
  if (!existsSync(COOK_STATE_FILE)) {
    return { ppid: {} };
  }

  try {
    const content = await readFile(COOK_STATE_FILE, "utf8");
    const data = JSON.parse(content) as Record<string, unknown>;

    // Detect old format (no ppid field)
    if (!data.ppid) {
      // Migrate old data to current PPID
      const oldState = data as CookState;
      return {
        ppid: {
          [String(process.ppid)]: {
            lastRunId: oldState.lastRunId,
            lastSessionId: oldState.lastSessionId,
            lastCheckpointId: oldState.lastCheckpointId,
            lastActiveAt: Date.now(),
          },
        },
      };
    }

    return data as unknown as CookStateFile;
  } catch {
    // If file is corrupted, return empty state
    return { ppid: {} };
  }
}

export async function loadCookState(): Promise<CookState> {
  const file = await loadCookStateFile();
  const ppid = String(process.ppid);
  const entry = file.ppid[ppid];

  if (!entry) return {};

  return {
    lastRunId: entry.lastRunId,
    lastSessionId: entry.lastSessionId,
    lastCheckpointId: entry.lastCheckpointId,
  };
}

export async function saveCookState(state: CookState): Promise<void> {
  // Ensure config directory exists
  await mkdir(CONFIG_DIR, { recursive: true });

  const file = await loadCookStateFile();
  const ppid = String(process.ppid);
  const now = Date.now();

  // Clean up stale entries (older than 48 hours)
  for (const key of Object.keys(file.ppid)) {
    const entry = file.ppid[key];
    if (entry && now - entry.lastActiveAt > STALE_THRESHOLD_MS) {
      delete file.ppid[key];
    }
  }

  // Merge with existing entry for this PPID
  const existing = file.ppid[ppid];
  file.ppid[ppid] = {
    lastRunId: state.lastRunId ?? existing?.lastRunId,
    lastSessionId: state.lastSessionId ?? existing?.lastSessionId,
    lastCheckpointId: state.lastCheckpointId ?? existing?.lastCheckpointId,
    lastActiveAt: now,
  };

  // Write state file
  await writeFile(COOK_STATE_FILE, JSON.stringify(file, null, 2), "utf8");
}
