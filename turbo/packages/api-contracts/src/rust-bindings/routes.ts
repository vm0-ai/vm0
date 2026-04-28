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

export interface RouteLike {
  readonly method?: unknown;
  readonly path?: unknown;
}

export interface RustRouteBinding {
  readonly route: RouteLike;
  readonly rustModulePath: readonly string[];
  readonly rustConstName: string;
}

export const rustRouteBindings = [
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
