import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const PID_DIR = join(homedir(), ".config", "vm0", "computer-connector", "pids");

async function ensurePidDir(): Promise<void> {
  await mkdir(PID_DIR, { recursive: true });
}

export async function writePid(service: string, pid: number): Promise<void> {
  await ensurePidDir();
  const pidFile = join(PID_DIR, `${service}.pid`);
  await writeFile(pidFile, String(pid), "utf-8");
}

export async function readPid(service: string): Promise<number | null> {
  const pidFile = join(PID_DIR, `${service}.pid`);
  const content = await readFile(pidFile, "utf-8");
  const pid = Number.parseInt(content.trim(), 10);
  return Number.isNaN(pid) ? null : pid;
}

export async function deletePid(service: string): Promise<void> {
  const pidFile = join(PID_DIR, `${service}.pid`);
  await unlink(pidFile);
}

export function getLogPath(service: string): string {
  return join(PID_DIR, `${service}.log`);
}
