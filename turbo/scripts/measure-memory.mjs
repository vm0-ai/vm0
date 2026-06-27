#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const separatorIndex = args.indexOf("--");
if (separatorIndex === -1 || separatorIndex === args.length - 1) {
  console.error(
    "Usage: node scripts/measure-memory.mjs [--label LABEL] [--json PATH] -- <command> [args...]",
  );
  process.exit(2);
}

let label = "measure";
let jsonPath;
for (let index = 0; index < separatorIndex; index += 1) {
  if (args[index] === "--label") {
    label = args[index + 1];
    index += 1;
  } else if (args[index] === "--json") {
    jsonPath = args[index + 1];
    index += 1;
  }
}

const command = args.slice(separatorIndex + 1);
let samples = 0;
let peakRssKiB = 0;
let peakPids = [];
const startedAt = Date.now();

function readParentPid(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    return Number.parseInt(stat.slice(end + 2).trim().split(/\s+/)[1], 10);
  } catch {
    return undefined;
  }
}

function readRssKiB(pid) {
  try {
    const match = readFileSync(`/proc/${pid}/status`, "utf8").match(
      /^VmRSS:\s+(\d+)\s+kB$/m,
    );
    return match ? Number.parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

function processTree(rootPid) {
  const childrenByParent = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = Number.parseInt(entry, 10);
    const parent = readParentPid(pid);
    if (!Number.isFinite(parent)) {
      continue;
    }
    const children = childrenByParent.get(parent) ?? [];
    children.push(pid);
    childrenByParent.set(parent, children);
  }

  const pids = [];
  const queue = [rootPid];
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index];
    pids.push(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return pids;
}

function sample(rootPid) {
  const pids = processTree(rootPid);
  const rss = pids.reduce((sum, pid) => sum + readRssKiB(pid), 0);
  samples += 1;
  if (rss > peakRssKiB) {
    peakRssKiB = rss;
    peakPids = pids;
  }
}

const child = spawn(command[0], command.slice(1), {
  env: process.env,
  stdio: "inherit",
});
sample(child.pid);
const timer = setInterval(() => sample(child.pid), 250);

child.on("exit", (exitCode, signal) => {
  clearInterval(timer);
  sample(child.pid);
  const endedAt = Date.now();
  const result = {
    label,
    command,
    exitCode,
    signal,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    samples,
    peakRssKiB,
    peakRssMiB: Math.round((peakRssKiB / 1024) * 10) / 10,
    peakPids,
  };
  const line = JSON.stringify(result);
  console.error(`\n[measure-memory] ${line}`);
  if (jsonPath) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    appendFileSync(jsonPath, `${line}\n`);
  }
  if (signal) {
    process.kill(process.pid, signal);
  }
  process.exit(exitCode ?? 1);
});
