import { and, eq, inArray, isNotNull, sql, desc } from "drizzle-orm";
import type { TaskItem, RunStatus } from "@vm0/core";
import { chatThreads } from "../../../db/schema/chat-thread";
import { zeroAgentSchedules } from "../../../db/schema/zero-agent-schedule";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentComposeVersions } from "../../../db/schema/agent-compose";
import { zeroRuns } from "../../../db/schema/zero-run";
import { voiceChatSessions } from "../../../db/schema/voice-chat";
import { zeroAgents } from "../../../db/schema/zero-agent";
import { archivedTaskRuns } from "../../../db/schema/archived-task-runs";

const TASKS_LIMIT = 25;
const PROMPT_SUMMARY_MAX_LENGTH = 100;
const TERMINAL_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "timeout",
  "cancelled",
]);

function truncatePrompt(prompt: string): string {
  if (prompt.length <= PROMPT_SUMMARY_MAX_LENGTH) return prompt;
  return prompt.slice(0, PROMPT_SUMMARY_MAX_LENGTH) + "…";
}

interface AgentInfo {
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
}

interface RawTask {
  id: string;
  type: TaskItem["type"];
  title: string | null;
  agent: AgentInfo;
  latestRunId: string | null;
  sourceUpdatedAt: Date;
  fallbackSummary?: string;
}

/**
 * List unified tasks across chat threads, schedules, voice chats, and agent runs.
 * Returns up to 25 tasks sorted by latest run time DESC.
 */
export async function listTasks(
  userId: string,
  orgId: string,
  agentId?: string,
): Promise<TaskItem[]> {
  const db = globalThis.services.db;

  const [chatTasks, scheduleTasks, voiceChatTasks, agentTasks, archivedSets] =
    await Promise.all([
      listChatTasks(db, userId, orgId, agentId),
      listScheduleTasks(db, userId, orgId, agentId),
      listVoiceChatTasks(db, userId, orgId, agentId),
      listAgentTasks(db, userId, orgId, agentId),
      getArchivedSets(db, userId, orgId),
    ]);

  const allTasks = [
    ...chatTasks,
    ...scheduleTasks,
    ...voiceChatTasks,
    ...agentTasks,
  ].filter((t) => {
    if (t.latestRunId === null) {
      return !archivedSets.nullRunTaskIds.has(t.id);
    }
    return !archivedSets.runIds.has(t.latestRunId);
  });

  // Batch-fetch run info for all tasks with a latestRunId
  const runIds = allTasks
    .map((t) => {
      return t.latestRunId;
    })
    .filter((id): id is string => {
      return id !== null;
    });

  const runInfoMap = new Map<
    string,
    { status: string; createdAt: Date; summary: string | null }
  >();

  if (runIds.length > 0) {
    const runs = await db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        createdAt: agentRuns.createdAt,
        summary: zeroRuns.summary,
        prompt: agentRuns.prompt,
      })
      .from(agentRuns)
      .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
      .where(inArray(agentRuns.id, runIds));

    for (const run of runs) {
      runInfoMap.set(run.id, {
        status: run.status,
        createdAt: run.createdAt,
        summary: run.summary ?? truncatePrompt(run.prompt),
      });
    }
  }

  // Build final task items with sort key
  const tasksWithSortKey = allTasks.map((raw) => {
    const runInfo = raw.latestRunId
      ? runInfoMap.get(raw.latestRunId)
      : undefined;
    const sortKey = runInfo ? runInfo.createdAt : raw.sourceUpdatedAt;

    const task: TaskItem = {
      id: raw.id,
      type: raw.type,
      title: raw.title,
      summary: runInfo?.summary ?? raw.fallbackSummary ?? null,
      agent: raw.agent,
      latestRunId: raw.latestRunId,
      status: runInfo ? (runInfo.status as TaskItem["status"]) : null,
      createdAt: raw.sourceUpdatedAt.toISOString(),
      updatedAt: sortKey.toISOString(),
    };

    // Add type-specific ID
    switch (raw.type) {
      case "chat":
        task.chatThreadId = raw.id;
        break;
      case "schedule":
        task.scheduleId = raw.id;
        break;
      case "voice_chat":
        task.voiceChatSessionId = raw.id;
        break;
      case "agent":
        task.agentRunId = raw.id;
        break;
    }

    return { task, sortKey };
  });

  // Sort: active tasks first (tier 0), terminal tasks second (tier 1); within each tier sort by sortKey DESC
  tasksWithSortKey.sort((a, b) => {
    const aTier =
      a.task.status !== null && TERMINAL_STATUSES.has(a.task.status) ? 1 : 0;
    const bTier =
      b.task.status !== null && TERMINAL_STATUSES.has(b.task.status) ? 1 : 0;
    if (aTier !== bTier) return aTier - bTier;
    return b.sortKey.getTime() - a.sortKey.getTime();
  });

  return tasksWithSortKey.slice(0, TASKS_LIMIT).map((t) => {
    return t.task;
  });
}

// -- Archive helpers --

type DB = typeof globalThis.services.db;

interface ArchivedSets {
  /** Run IDs that have been archived (for tasks with a latestRunId). */
  runIds: Set<string>;
  /** Task IDs archived when they had no run at the time of archival. */
  nullRunTaskIds: Set<string>;
}

/**
 * Returns two sets for archive filtering:
 * - runIds: archived run IDs (tasks hidden when latestRunId matches)
 * - nullRunTaskIds: task IDs archived when they had no run yet (hidden when latestRunId is still null)
 */
async function getArchivedSets(
  db: DB,
  userId: string,
  orgId: string,
): Promise<ArchivedSets> {
  const rows = await db
    .select({
      taskId: archivedTaskRuns.taskId,
      archivedRunId: archivedTaskRuns.archivedRunId,
    })
    .from(archivedTaskRuns)
    .where(
      and(
        eq(archivedTaskRuns.userId, userId),
        eq(archivedTaskRuns.orgId, orgId),
      ),
    );

  const runIds = new Set<string>();
  const nullRunTaskIds = new Set<string>();
  for (const row of rows) {
    if (row.archivedRunId !== null) {
      runIds.add(row.archivedRunId);
    } else {
      nullRunTaskIds.add(row.taskId);
    }
  }
  return { runIds, nullRunTaskIds };
}

export async function archiveTask(
  userId: string,
  orgId: string,
  taskId: string,
  taskType: string,
  runId: string | null,
): Promise<void> {
  const db = globalThis.services.db;
  await db
    .insert(archivedTaskRuns)
    .values({ userId, orgId, taskId, taskType, archivedRunId: runId })
    .onConflictDoUpdate({
      target: [
        archivedTaskRuns.userId,
        archivedTaskRuns.orgId,
        archivedTaskRuns.taskId,
        archivedTaskRuns.taskType,
      ],
      set: { archivedRunId: runId, createdAt: new Date() },
    });
}

export async function unarchiveTask(
  userId: string,
  orgId: string,
  taskId: string,
  taskType: string,
): Promise<void> {
  const db = globalThis.services.db;
  await db
    .delete(archivedTaskRuns)
    .where(
      and(
        eq(archivedTaskRuns.userId, userId),
        eq(archivedTaskRuns.orgId, orgId),
        eq(archivedTaskRuns.taskId, taskId),
        eq(archivedTaskRuns.taskType, taskType),
      ),
    );
}

// -- Per-source query functions --

async function listChatTasks(
  db: DB,
  userId: string,
  orgId: string,
  agentId?: string,
): Promise<RawTask[]> {
  const conditions = [
    eq(chatThreads.userId, userId),
    eq(zeroAgents.orgId, orgId),
  ];
  if (agentId) conditions.push(eq(chatThreads.agentComposeId, agentId));

  const rows = await db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      agentId: chatThreads.agentComposeId,
      agentName: zeroAgents.name,
      agentDisplayName: zeroAgents.displayName,
      agentAvatarUrl: zeroAgents.avatarUrl,
      updatedAt: chatThreads.updatedAt,
      latestRunId: sql<string | null>`(
        SELECT ${zeroRuns.id}
        FROM ${zeroRuns}
        INNER JOIN ${agentRuns} ON ${agentRuns.id} = ${zeroRuns.id}
        WHERE ${zeroRuns.chatThreadId} = ${chatThreads.id}
        ORDER BY ${agentRuns.createdAt} DESC
        LIMIT 1
      )`,
    })
    .from(chatThreads)
    .innerJoin(zeroAgents, eq(chatThreads.agentComposeId, zeroAgents.id))
    .where(and(...conditions));

  return rows.map((r) => {
    return {
      id: r.id,
      type: "chat" as const,
      title: r.title,
      agent: {
        id: r.agentId,
        name: r.agentName,
        displayName: r.agentDisplayName,
        avatarUrl: r.agentAvatarUrl,
      },
      latestRunId: r.latestRunId,
      sourceUpdatedAt: r.updatedAt,
    };
  });
}

async function listScheduleTasks(
  db: DB,
  userId: string,
  orgId: string,
  agentId?: string,
): Promise<RawTask[]> {
  const conditions = [
    eq(zeroAgentSchedules.userId, userId),
    eq(zeroAgentSchedules.orgId, orgId),
    isNotNull(zeroAgentSchedules.lastRunId),
  ];
  if (agentId) conditions.push(eq(zeroAgentSchedules.agentId, agentId));

  const rows = await db
    .select({
      id: zeroAgentSchedules.id,
      name: zeroAgentSchedules.name,
      prompt: zeroAgentSchedules.prompt,
      agentId: zeroAgentSchedules.agentId,
      agentName: zeroAgents.name,
      agentDisplayName: zeroAgents.displayName,
      agentAvatarUrl: zeroAgents.avatarUrl,
      lastRunId: zeroAgentSchedules.lastRunId,
      updatedAt: zeroAgentSchedules.updatedAt,
    })
    .from(zeroAgentSchedules)
    .innerJoin(zeroAgents, eq(zeroAgentSchedules.agentId, zeroAgents.id))
    .where(and(...conditions));

  return rows.map((r) => {
    return {
      id: r.id,
      type: "schedule" as const,
      title: r.name,
      agent: {
        id: r.agentId,
        name: r.agentName,
        displayName: r.agentDisplayName,
        avatarUrl: r.agentAvatarUrl,
      },
      latestRunId: r.lastRunId,
      sourceUpdatedAt: r.updatedAt,
      fallbackSummary: truncatePrompt(r.prompt),
    };
  });
}

/**
 * Return agent-triggered runs (triggerSource = 'agent') as individual tasks.
 * Each delegation run becomes its own task showing the delegated agent's info.
 */
async function listAgentTasks(
  db: DB,
  userId: string,
  orgId: string,
  agentId?: string,
): Promise<RawTask[]> {
  const conditions = [
    eq(agentRuns.userId, userId),
    eq(agentRuns.orgId, orgId),
    eq(zeroRuns.triggerSource, "agent"),
  ];
  if (agentId) {
    conditions.push(eq(zeroAgents.id, agentId));
  }

  const rows = await db
    .select({
      id: agentRuns.id,
      agentId: zeroAgents.id,
      agentName: zeroAgents.name,
      agentDisplayName: zeroAgents.displayName,
      agentAvatarUrl: zeroAgents.avatarUrl,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .innerJoin(
      agentComposeVersions,
      eq(agentComposeVersions.id, agentRuns.agentComposeVersionId),
    )
    .innerJoin(zeroAgents, eq(zeroAgents.id, agentComposeVersions.composeId))
    .where(and(...conditions))
    .orderBy(desc(agentRuns.createdAt))
    .limit(TASKS_LIMIT);

  return rows.map((r) => {
    return {
      id: r.id,
      type: "agent" as const,
      title: null,
      agent: {
        id: r.agentId,
        name: r.agentName,
        displayName: r.agentDisplayName,
        avatarUrl: r.agentAvatarUrl,
      },
      latestRunId: r.id,
      sourceUpdatedAt: r.createdAt,
    };
  });
}

/**
 * Return the most recent voice-chat session for this user/org as a single task.
 * At most one voice-chat task is shown regardless of how many sessions exist.
 */
async function listVoiceChatTasks(
  db: DB,
  userId: string,
  orgId: string,
  agentId?: string,
): Promise<RawTask[]> {
  const conditions = [
    eq(voiceChatSessions.userId, userId),
    eq(voiceChatSessions.orgId, orgId),
    isNotNull(voiceChatSessions.runId),
  ];
  if (agentId) conditions.push(eq(voiceChatSessions.agentId, agentId));

  const rows = await db
    .select({
      id: voiceChatSessions.id,
      agentId: voiceChatSessions.agentId,
      agentName: zeroAgents.name,
      agentDisplayName: zeroAgents.displayName,
      agentAvatarUrl: zeroAgents.avatarUrl,
      runId: voiceChatSessions.runId,
      createdAt: voiceChatSessions.createdAt,
    })
    .from(voiceChatSessions)
    .innerJoin(zeroAgents, eq(voiceChatSessions.agentId, zeroAgents.id))
    .where(and(...conditions))
    .orderBy(desc(voiceChatSessions.createdAt))
    .limit(1);

  return rows
    .filter((r): r is typeof r & { agentId: string } => {
      return r.agentId !== null;
    })
    .map((r) => {
      return {
        id: r.id,
        type: "voice_chat" as const,
        title: null,
        agent: {
          id: r.agentId,
          name: r.agentName,
          displayName: r.agentDisplayName,
          avatarUrl: r.agentAvatarUrl,
        },
        latestRunId: r.runId,
        sourceUpdatedAt: r.createdAt,
      };
    });
}
