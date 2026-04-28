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
    rustModulePath: ["webhooks", "agent_events"],
    rustConstName: "SEND",
  },
  {
    route: webhookCheckpointsContract.create,
    rustModulePath: ["webhooks", "agent_checkpoints"],
    rustConstName: "CREATE",
  },
  {
    route: webhookCheckpointsPrepareHistoryContract.prepare,
    rustModulePath: ["webhooks", "agent_checkpoint_prepare_history"],
    rustConstName: "PREPARE",
  },
  {
    route: webhookCompleteContract.complete,
    rustModulePath: ["webhooks", "agent_complete"],
    rustConstName: "COMPLETE",
  },
  {
    route: webhookHeartbeatContract.send,
    rustModulePath: ["webhooks", "agent_heartbeat"],
    rustConstName: "SEND",
  },
  {
    route: webhookTelemetryContract.send,
    rustModulePath: ["webhooks", "agent_telemetry"],
    rustConstName: "SEND",
  },
  {
    route: webhookStoragesPrepareContract.prepare,
    rustModulePath: ["webhooks", "agent_storage_prepare"],
    rustConstName: "PREPARE",
  },
  {
    route: webhookStoragesCommitContract.commit,
    rustModulePath: ["webhooks", "agent_storage_commit"],
    rustConstName: "COMMIT",
  },
] as const satisfies readonly RustRouteBinding[];
