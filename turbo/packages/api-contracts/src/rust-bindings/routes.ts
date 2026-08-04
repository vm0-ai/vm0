import { buildInfoContract } from "../contracts/build-info";
import { runnerRealtimeTokenContract } from "../contracts/realtime";
import {
  runnersNetworkPolicyRefreshContract,
  runnersBuiltinFirewallsResolveContract,
  runnersHeartbeatContract,
  runnersJobClaimContract,
  runnersPollContract,
} from "../contracts/runners";
import {
  webhookCheckpointsContract,
  webhookCheckpointsPrepareHistoryContract,
  webhookCompleteContract,
  webhookEventsContract,
  webhookHeartbeatContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
  webhookTelemetryContract,
} from "../contracts/webhooks";
import { zeroModelPoliciesMainContract } from "../contracts/zero-model-policies";
import { zeroBankingContract } from "../contracts/zero-banking";
import { zeroFinanceContract } from "../contracts/zero-finance";
import { zeroPeopleSearchContract } from "../contracts/zero-people-search";
import { zeroScrapeContract } from "../contracts/zero-scrape";
import { zeroUserModelPreferenceContract } from "../contracts/zero-user-model-preference";
import { zeroWebSearchContract } from "../contracts/zero-web-search";

export interface RouteLike {
  readonly method?: unknown;
  readonly path?: unknown;
  readonly summary?: unknown;
}

export interface RustRouteBinding {
  readonly route: RouteLike;
  readonly rustModulePath: readonly string[];
  readonly rustConstName: string;
}

export const rustRouteBindings = [
  {
    route: buildInfoContract.get,
    rustModulePath: ["build_info"],
    rustConstName: "GET",
  },
  {
    route: zeroModelPoliciesMainContract.list,
    rustModulePath: ["zero", "model_policies"],
    rustConstName: "LIST",
  },
  {
    route: zeroUserModelPreferenceContract.get,
    rustModulePath: ["zero", "user_model_preference"],
    rustConstName: "GET",
  },
  {
    route: zeroScrapeContract.scrape,
    rustModulePath: ["zero", "scrape"],
    rustConstName: "SCRAPE",
  },
  {
    route: zeroPeopleSearchContract.search,
    rustModulePath: ["zero", "people_search"],
    rustConstName: "SEARCH",
  },
  {
    route: zeroWebSearchContract.search,
    rustModulePath: ["zero", "web_search"],
    rustConstName: "SEARCH",
  },
  {
    route: zeroFinanceContract.search,
    rustModulePath: ["zero", "finance"],
    rustConstName: "SEARCH",
  },
  {
    route: zeroFinanceContract.profile,
    rustModulePath: ["zero", "finance"],
    rustConstName: "PROFILE",
  },
  {
    route: zeroFinanceContract.quote,
    rustModulePath: ["zero", "finance"],
    rustConstName: "QUOTE",
  },
  {
    route: zeroFinanceContract.chart,
    rustModulePath: ["zero", "finance"],
    rustConstName: "CHART",
  },
  {
    route: zeroBankingContract.accounts,
    rustModulePath: ["zero", "banking"],
    rustConstName: "ACCOUNTS",
  },
  {
    route: zeroBankingContract.balances,
    rustModulePath: ["zero", "banking"],
    rustConstName: "BALANCES",
  },
  {
    route: zeroBankingContract.transactions,
    rustModulePath: ["zero", "banking"],
    rustConstName: "TRANSACTIONS",
  },
  {
    route: runnersPollContract.poll,
    rustModulePath: ["runners", "poll"],
    rustConstName: "POLL",
  },
  {
    route: runnersJobClaimContract.claim,
    rustModulePath: ["runners", "jobs", "by_id", "claim"],
    rustConstName: "CLAIM",
  },
  {
    route: runnersNetworkPolicyRefreshContract.refresh,
    rustModulePath: ["runners", "runs", "by_run_id", "network_policy_refresh"],
    rustConstName: "REFRESH",
  },
  {
    route: runnersBuiltinFirewallsResolveContract.resolve,
    rustModulePath: ["runners", "builtin_firewalls", "resolve"],
    rustConstName: "RESOLVE",
  },
  {
    route: runnersHeartbeatContract.heartbeat,
    rustModulePath: ["runners", "heartbeat"],
    rustConstName: "HEARTBEAT",
  },
  {
    route: runnerRealtimeTokenContract.create,
    rustModulePath: ["runners", "realtime", "token"],
    rustConstName: "CREATE",
  },
  {
    route: webhookEventsContract.send,
    rustModulePath: ["webhooks", "agent", "events"],
    rustConstName: "SEND",
  },
  {
    route: webhookCheckpointsContract.create,
    rustModulePath: ["webhooks", "agent", "checkpoints"],
    rustConstName: "CREATE",
  },
  {
    route: webhookCheckpointsPrepareHistoryContract.prepare,
    rustModulePath: ["webhooks", "agent", "checkpoints", "prepare_history"],
    rustConstName: "PREPARE",
  },
  {
    route: webhookCompleteContract.complete,
    rustModulePath: ["webhooks", "agent", "complete"],
    rustConstName: "COMPLETE",
  },
  {
    route: webhookHeartbeatContract.send,
    rustModulePath: ["webhooks", "agent", "heartbeat"],
    rustConstName: "SEND",
  },
  {
    route: webhookTelemetryContract.send,
    rustModulePath: ["webhooks", "agent", "telemetry"],
    rustConstName: "SEND",
  },
  {
    route: webhookStoragesPrepareContract.prepare,
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustConstName: "PREPARE",
  },
  {
    route: webhookStoragesCommitContract.commit,
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustConstName: "COMMIT",
  },
] as const satisfies readonly RustRouteBinding[];
