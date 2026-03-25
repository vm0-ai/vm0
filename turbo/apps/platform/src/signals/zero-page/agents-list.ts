import { command, computed, state } from "ccstate";
import {
  zeroTeamContract,
  zeroSchedulesMainContract,
  type TeamComposeItem,
} from "@vm0/core";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { zeroClient$ } from "../api-client.ts";

const L = logger("AgentsList");

interface Schedule {
  name: string;
  agentId: string;
  enabled: boolean;
  cronExpression: string | null;
  atTime: string | null;
  timezone: string;
}

interface AgentsListState {
  agents: TeamComposeItem[];
  schedules: Schedule[];
  loading: boolean;
  error: string | null;
}

const agentsListState$ = state<AgentsListState>({
  agents: [],
  schedules: [],
  loading: false,
  error: null,
});

export const agentsList$ = computed((get) => get(agentsListState$).agents);
export const agentsLoading$ = computed((get) => get(agentsListState$).loading);
export const agentsError$ = computed((get) => get(agentsListState$).error);

export const fetchAgentsList$ = command(async ({ get, set }) => {
  set(agentsListState$, (prev) => ({ ...prev, loading: true, error: null }));

  try {
    // Fetch agents from app team endpoint (uses Clerk active org)
    const teamClient = get(zeroClient$)(zeroTeamContract);
    const agentsResult = await teamClient.list();

    if (agentsResult.status !== 200) {
      throw new Error(`Failed to fetch agents (${agentsResult.status})`);
    }

    const agents = agentsResult.body;

    // Fetch schedules (optional - don't fail if schedules API is unavailable)
    let schedules: Schedule[] = [];
    try {
      const schedulesClient = get(zeroClient$)(zeroSchedulesMainContract);
      const schedulesResult = await schedulesClient.list();
      if (schedulesResult.status === 200) {
        schedules = schedulesResult.body.schedules;
      }
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to fetch schedules:", error);
    }

    set(agentsListState$, {
      agents,
      schedules,
      loading: false,
      error: null,
    });
  } catch (error) {
    throwIfAbort(error);
    set(agentsListState$, (prev) => ({
      ...prev,
      loading: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }));
  }
});
