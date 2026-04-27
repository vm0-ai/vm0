import "server-only";
import { and, desc, eq, gte } from "drizzle-orm";
import { voiceChatTasks } from "@vm0/db/schema/voice-chat";

const WINDOW_MS = 3 * 60 * 1000;
const MAX_EVENTS_PER_TASK = 10;
const MAX_TOTAL_CHARS = 4000;

type TaskEvent = {
  at: Date;
  label: string;
};

type TaskRow = typeof voiceChatTasks.$inferSelect;

export async function buildRecentTaskLogs(
  sessionId: string,
  now: Date = new Date(),
): Promise<string> {
  const db = globalThis.services.db;
  const cutoff = new Date(now.getTime() - WINDOW_MS);

  const rows = await db
    .select()
    .from(voiceChatTasks)
    .where(
      and(
        eq(voiceChatTasks.sessionId, sessionId),
        gte(voiceChatTasks.createdAt, cutoff),
      ),
    )
    .orderBy(desc(voiceChatTasks.createdAt));

  const recent = rows.filter((row) => {
    return taskLastActivityAt(row).getTime() >= cutoff.getTime();
  });

  if (recent.length === 0) return "";

  const blocks: string[] = [];
  let totalChars = 0;
  for (const row of recent) {
    const block = formatTaskBlock(row, now);
    if (totalChars + block.length > MAX_TOTAL_CHARS) break;
    blocks.push(block);
    totalChars += block.length;
  }

  return blocks.join("\n\n");
}

function taskLastActivityAt(row: TaskRow): Date {
  return (
    row.finishedAt ?? lastResultEntryAt(row) ?? row.startedAt ?? row.createdAt
  );
}

function lastResultEntryAt(row: TaskRow): Date | null {
  const last = row.assistantMessages[row.assistantMessages.length - 1];
  if (!last) return null;
  const parsed = new Date(last.at);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatTaskBlock(row: TaskRow, now: Date): string {
  const events = collectEvents(row);
  const trimmed = events.slice(-MAX_EVENTS_PER_TASK);
  const header = `[Task ${row.id}] ${row.status} — created ${formatAgo(row.createdAt, now)} — ${truncatePrompt(row.prompt)}`;
  const lines = trimmed.map((e) => {
    return `  ${formatAgo(e.at, now)}: ${e.label}`;
  });
  return [header, ...lines].join("\n");
}

function collectEvents(row: TaskRow): TaskEvent[] {
  const events: TaskEvent[] = [{ at: row.createdAt, label: "created" }];
  if (row.startedAt) {
    events.push({ at: row.startedAt, label: "running" });
  }
  for (const entry of row.assistantMessages) {
    const at = new Date(entry.at);
    if (Number.isNaN(at.getTime())) continue;
    events.push({
      at,
      label: `assistant: ${truncateEntry(entry.content)}`,
    });
  }
  if (row.finishedAt) {
    const label = row.error ? `failed: ${truncateEntry(row.error)}` : "done";
    events.push({ at: row.finishedAt, label });
  }
  events.sort((a, b) => {
    return a.at.getTime() - b.at.getTime();
  });
  return events;
}

function truncatePrompt(prompt: string, max = 80): string {
  const trimmed = prompt.trim().replace(/\s+/gu, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function truncateEntry(text: string, max = 200): string {
  const trimmed = text.trim().replace(/\s+/gu, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function formatAgo(then: Date, now: Date): string {
  const diffMs = Math.max(0, now.getTime() - then.getTime());
  const totalSec = Math.floor(diffMs / 1000);
  if (totalSec < 60) return `${totalSec}s ago`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const s = totalSec % 60;
    return `${totalMin}m ${s}s ago`;
  }
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m ago`;
}
