import {
  appBootstrapContract,
  type AppBootstrapResponseEntry,
} from "@okouai/api-contracts/contracts/app-bootstrap";
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { command } from "ccstate";

import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";
import { agentListResponse$ } from "./agents";
import { featureSwitchesResponse$ } from "./feature-switches";

const AGENT_CHAT_PATH = /^\/agents\/[^/]+\/chat\/?$/u;

function responseEntry(path: string, body: unknown): AppBootstrapResponseEntry {
  return {
    method: "GET",
    path,
    contentType: "application/json",
    body,
  };
}

const getAppBootstrap$ = command(
  async ({ get }, signal: AbortSignal): Promise<unknown> => {
    const { path } = get(queryOf(appBootstrapContract.get));
    if (!AGENT_CHAT_PATH.test(new URL(path, "https://app.invalid").pathname)) {
      return { status: 200 as const, body: { responses: [] } };
    }

    const [featureSwitches, agents] = await Promise.all([
      settle(get(featureSwitchesResponse$), signal),
      settle(get(agentListResponse$), signal),
    ]);
    signal.throwIfAborted();

    const responses: AppBootstrapResponseEntry[] = [];
    if (featureSwitches.ok) {
      responses.push(
        responseEntry(
          featureSwitchesContract.get.path,
          featureSwitches.value.body,
        ),
      );
    }
    if (agents.ok) {
      responses.push(
        responseEntry(agentsMainContract.list.path, agents.value.body),
      );
    }

    return { status: 200 as const, body: { responses } };
  },
);

export const appBootstrapRoutes: readonly RouteEntry[] = [
  {
    route: appBootstrapContract.get,
    handler: authRoute(
      {
        accept: ["session"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      getAppBootstrap$,
    ),
  },
];
