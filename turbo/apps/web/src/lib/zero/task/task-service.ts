import { and, eq, inArray, isNull, sql, desc } from "drizzle-orm";
import type { TaskItem } from "@vm0/core";
import { chatThreads, chatThreadRuns } from "../../../db/schema/chat-thread";
import { zeroAgentSchedules } from "../../../db/schema/zero-agent-schedule";
import { slackOrgThreadSessions } from "../../../db/schema/slack-org-thread-session";
import { slackOrgConnections } from "../../../db/schema/slack-org-connection";
import { slackOrgInstallations } from "../../../db/schema/slack-org-installation";
import { emailThreadSessions } from "../../../db/schema/email-thread-session";
import { agentSessions } from "../../../db/schema/agent-session";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentComposeVersions } from "../../../db/schema/agent-compose";
import { zeroRuns } from "../../../db/schema/zero-run";
import { voiceChatSessions } from "../../../db/schema/voice-chat";
import { zeroAgents } from "../../../db/schema/zero-agent";
import { archivedTaskRuns } from "../../../db/schema/archived-task-runs";

const TASKS_LIMIT = 25;
const PROMPT_SUMMARY_MAX_LENGTH = 100;

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
}

/**
 * List unified tasks across chat threads, schedules, slack threads, and email threads.
 * Returns up to 25 tasks sorted by latest run time DESC.
 */
export async function listTasks(
  userId: string,
  orgId: string,
  agentId?: string,
): Promise<TaskItem[]> {
  const db = globalThis.services.db;

  const [
    chatTasks,
    scheduleTasks,
    slackTasks,
    emailTasks,
    inFlightEmailTasks,
    voiceChatTasks,
    agentTasks,
    archiveSet,
  ] = await Promise.all([
    listChatTasks(db, userId, orgId, agentId),
    listScheduleTasks(db, userId, orgId, agentId),
    listSlackTasks(db, userId, orgId, agentId),
    listEmailTasks(db, userId, orgId, agentId),
    listInFlightEmailTasks(db, userId, orgId, agentId),
    listVoiceChatTasks(db, userId, orgId, agentId),
    listAgentTasks(db, userId, orgId, agentId),
    getArchiveSet(db, userId, orgId),
  ]);

  const allTasks = [
    ...chatTasks,
    ...scheduleTasks,
    ...slackTasks,
    ...emailTasks,
    ...inFlightEmailTasks,
    ...voiceChatTasks,
    ...agentTasks,
  ].filter((t) => {
    const key = `${t.id}:${t.type}`;
    if (!archiveSet.has(key)) return true;
    // Re-show if latestRunId has changed (new run arrived since archive)
    return t.latestRunId !== archiveSet.get(key);
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
      summary: runInfo?.summary ?? null,
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
      case "slack":
        task.slackThreadSessionId = raw.id;
        break;
      case "email":
        task.emailThreadSessionId = raw.id;
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

  // Sort by sortKey DESC (latest first) and take top N
  tasksWithSortKey.sort((a, b) => {
    return b.sortKey.getTime() - a.sortKey.getTime();
  });

  return tasksWithSortKey.slice(0, TASKS_LIMIT).map((t) => {
    return t.task;
  });
}

// -- Archive helpers --

type DB = typeof globalThis.services.db;

/**
 * Returns a map of archived tasks: key = "taskId:taskType", value = archivedRunId (or null).
 */
async function getArchiveSet(
  db: DB,
  userId: string,
  orgId: string,
): Promise<Map<string, string | null>> {
  const rows = await db
    .select({
      taskId: archivedTaskRuns.taskId,
      taskType: archivedTaskRuns.taskType,
      archivedRunId: archivedTaskRuns.archivedRunId,
    })
    .from(archivedTaskRuns)
    .where(
      and(
        eq(archivedTaskRuns.userId, userId),
        eq(archivedTaskRuns.orgId, orgId),
      ),
    );

  const map = new Map<string, string | null>();
  for (const row of rows) {
    map.set(`${row.taskId}:${row.taskType}`, row.archivedRunId);
  }
  return map;
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
        SELECT ${chatThreadRuns.runId}
        FROM ${chatThreadRuns}
        WHERE ${chatThreadRuns.chatThreadId} = ${chatThreads.id}
        ORDER BY ${chatThreadRuns.createdAt} DESC
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
  ];
  if (agentId) conditions.push(eq(zeroAgentSchedules.agentId, agentId));

  const rows = await db
    .select({
      id: zeroAgentSchedules.id,
      name: zeroAgentSchedules.name,
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
    };
  });
}

async function listSlackTasks(
  db: DB,
  userId: string,
  orgId: string,
  agentId?: string,
): Promise<RawTask[]> {
  const conditions = [
    eq(slackOrgConnections.vm0UserId, userId),
    eq(slackOrgInstallations.orgId, orgId),
  ];
  if (agentId) conditions.push(eq(agentSessions.agentComposeId, agentId));

  const rows = await db
    .select({
      id: slackOrgThreadSessions.id,
      agentId: agentSessions.agentComposeId,
      agentName: zeroAgents.name,
      agentDisplayName: zeroAgents.displayName,
      agentAvatarUrl: zeroAgents.avatarUrl,
      agentSessionId: slackOrgThreadSessions.agentSessionId,
      updatedAt: slackOrgThreadSessions.updatedAt,
      latestRunId: sql<string | null>`(
        SELECT ${agentRuns.id}
        FROM ${agentRuns}
        WHERE ${agentRuns.continuedFromSessionId} = ${slackOrgThreadSessions.agentSessionId}
        ORDER BY ${agentRuns.createdAt} DESC
        LIMIT 1
      )`,
    })
    .from(slackOrgThreadSessions)
    .innerJoin(
      slackOrgConnections,
      eq(slackOrgThreadSessions.connectionId, slackOrgConnections.id),
    )
    .innerJoin(
      slackOrgInstallations,
      eq(
        slackOrgConnections.slackWorkspaceId,
        slackOrgInstallations.slackWorkspaceId,
      ),
    )
    .innerJoin(
      agentSessions,
      eq(slackOrgThreadSessions.agentSessionId, agentSessions.id),
    )
    .innerJoin(zeroAgents, eq(agentSessions.agentComposeId, zeroAgents.id))
    .where(and(...conditions));

  return rows.map((r) => {
    return {
      id: r.id,
      type: "slack" as const,
      title: null,
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

async function listEmailTasks(
  db: DB,
  userId: string,
  orgId: string,
  agentId?: string,
): Promise<RawTask[]> {
  const conditions = [
    eq(emailThreadSessions.userId, userId),
    eq(zeroAgents.orgId, orgId),
  ];
  if (agentId) conditions.push(eq(emailThreadSessions.agentId, agentId));

  const rows = await db
    .select({
      id: emailThreadSessions.id,
      agentId: emailThreadSessions.agentId,
      agentName: zeroAgents.name,
      agentDisplayName: zeroAgents.displayName,
      agentAvatarUrl: zeroAgents.avatarUrl,
      agentSessionId: emailThreadSessions.agentSessionId,
      updatedAt: emailThreadSessions.updatedAt,
      latestRunId: sql<string | null>`(
        SELECT ${agentRuns.id}
        FROM ${agentRuns}
        WHERE ${agentRuns.continuedFromSessionId} = ${emailThreadSessions.agentSessionId}
           OR ${agentRuns.result}->>'agentSessionId' = ${emailThreadSessions.agentSessionId}::text
        ORDER BY ${agentRuns.createdAt} DESC
        LIMIT 1
      )`,
    })
    .from(emailThreadSessions)
    .innerJoin(zeroAgents, eq(emailThreadSessions.agentId, zeroAgents.id))
    .where(and(...conditions));

  return rows.map((r) => {
    return {
      id: r.id,
      type: "email" as const,
      title: null,
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

/**
 * Find email-triggered runs that are still active (pending/running/paused)
 * and have not yet produced an emailThreadSessions record. This covers the
 * window between email arrival and run completion, where the thread session
 * does not yet exist but the task should still appear in Mission Control.
 *
 * Only new-thread runs are included (continuedFromSessionId IS NULL).
 * Reply runs are excluded because their parent emailThreadSession already
 * surfaces the task via listEmailTasks.
 */
async function listInFlightEmailTasks(
  db: DB,
  userId: string,
  orgId: string,
  agentId?: string,
): Promise<RawTask[]> {
  const activeStatuses = ["pending", "running", "paused"];
  const conditions = [
    eq(agentRuns.userId, userId),
    eq(agentRuns.orgId, orgId),
    eq(zeroRuns.triggerSource, "email"),
    inArray(agentRuns.status, activeStatuses),
    isNull(agentRuns.continuedFromSessionId),
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
    .where(and(...conditions));

  return rows.map((r) => {
    return {
      id: r.id,
      type: "email" as const,
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
