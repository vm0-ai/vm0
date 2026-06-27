import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";

import { now } from "../external/time";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { onRejection } from "../utils";

type ApiDispatchTimingSpanKind = "top_level" | "nested";
export type ApiDispatchTimingDimensions = Readonly<Record<string, string>>;

export type ApiDispatchTimingActionType =
  | "api_dispatch_pre_create_agent_run"
  | "api_dispatch_pre_create_direct_parse_body"
  | "api_dispatch_pre_create_direct_prepare_args"
  | "api_dispatch_pre_create_zero_parse_body"
  | "api_dispatch_pre_create_zero_prepare_args"
  | "api_dispatch_pre_create_zero_entrypoint_gap"
  | "api_dispatch_pre_create_zero_resolve_agent_id"
  | "api_dispatch_pre_create_zero_load_agent"
  | "api_dispatch_pre_create_zero_load_user_info"
  | "api_dispatch_pre_create_zero_resolve_trigger_context"
  | "api_dispatch_pre_create_zero_load_connector_scopes"
  | "api_dispatch_pre_create_zero_load_workflows"
  | "api_dispatch_pre_create_zero_resolve_permission_policies"
  | "api_dispatch_pre_create_zero_build_create_run_args"
  | "api_dispatch_check_org_tier"
  | "api_dispatch_prepare_run_context"
  | "api_dispatch_prepare_context_feature_switches"
  | "api_dispatch_prepare_context_resolve_compose"
  | "api_dispatch_prepare_context_load_persisted_environment"
  | "api_dispatch_prepare_context_build_resolved_body"
  | "api_dispatch_prepare_context_resolve_framework"
  | "api_dispatch_prepare_context_resolve_connector_scope"
  | "api_dispatch_prepare_context_resolve_model_provider"
  | "api_dispatch_prepare_context_load_connector_contexts"
  | "api_dispatch_prepare_context_load_stored_connectors"
  | "api_dispatch_prepare_context_load_stored_connector_rows"
  | "api_dispatch_prepare_context_filter_stored_connector_rows"
  | "api_dispatch_prepare_context_load_stored_connector_secret_rows"
  | "api_dispatch_prepare_context_decrypt_stored_connector_secrets"
  | "api_dispatch_prepare_context_load_stored_connector_variable_rows"
  | "api_dispatch_prepare_context_build_stored_connector_state"
  | "api_dispatch_prepare_context_load_custom_connectors"
  | "api_dispatch_prepare_context_load_custom_connector_rows"
  | "api_dispatch_prepare_context_load_custom_connector_value_rows"
  | "api_dispatch_prepare_context_build_custom_connector_firewalls"
  | "api_dispatch_prepare_context_build_permission_manifest"
  | "api_dispatch_prepare_context_load_builtin_permission_indexes"
  | "api_dispatch_prepare_context_apply_builtin_permission_policies"
  | "api_dispatch_prepare_context_apply_custom_permission_policies"
  | "api_dispatch_prepare_context_apply_model_provider_permission_policy"
  | "api_dispatch_prepare_context_merge_permission_manifest"
  | "api_dispatch_prepare_context_validate_environment"
  | "api_dispatch_prepare_context_load_user_timezone"
  | "api_dispatch_prepare_context_prepare_output_metadata"
  | "api_dispatch_resolve_compose_by_compose_id"
  | "api_dispatch_resolve_compose_by_version_id"
  | "api_dispatch_resolve_compose_by_session_id"
  | "api_dispatch_resolve_compose_by_checkpoint_id"
  | "api_dispatch_resolve_compose_lookup_compose"
  | "api_dispatch_resolve_compose_lookup_version"
  | "api_dispatch_resolve_compose_lookup_session"
  | "api_dispatch_resolve_compose_lookup_checkpoint"
  | "api_dispatch_resolve_compose_load_resume_session"
  | "api_dispatch_resolve_compose_resolve_session_history"
  | "api_dispatch_resolve_compose_lookup_session_vars"
  | "api_dispatch_check_vm0_credits"
  | "api_dispatch_insert_run_with_concurrency"
  | "api_dispatch_mark_pending_heartbeat"
  | "api_dispatch_build_runner_job_payload"
  | "api_dispatch_persist_runner_job_queue"
  | "api_dispatch_lock_run_for_queue_persistence"
  | "api_dispatch_insert_runner_job_queue"
  | "api_dispatch_update_run_runner_group"
  | "api_dispatch_admission_lock_wait"
  | "api_dispatch_check_concurrency_limit"
  | "api_dispatch_insert_run_record"
  | "api_dispatch_prepare_storage_manifest"
  | "api_dispatch_prepare_storage_manifest_resolve_inputs"
  | "api_dispatch_prepare_storage_manifest_ensure_artifacts"
  | "api_dispatch_prepare_storage_manifest_load_storage_index"
  | "api_dispatch_prepare_storage_manifest_build_entries"
  | "api_dispatch_prepare_storage_manifest_build_compose_entries"
  | "api_dispatch_prepare_storage_manifest_build_additional_entries"
  | "api_dispatch_prepare_storage_manifest_build_artifact_entries"
  | "api_dispatch_prepare_storage_manifest_assemble"
  | "api_dispatch_build_stored_execution_context";

interface ApiDispatchTimingRecord {
  readonly actionType: ApiDispatchTimingActionType;
  readonly spanKind: ApiDispatchTimingSpanKind;
  readonly durationMs: number;
  readonly timestamp: string;
  readonly dimensions?: ApiDispatchTimingDimensions;
}

export class ApiDispatchTimingCollector {
  private readonly records: ApiDispatchTimingRecord[] = [];

  recordElapsed(
    actionType: ApiDispatchTimingActionType,
    spanKind: ApiDispatchTimingSpanKind,
    startedAt: number,
    finishedAt: number = now(),
    dimensions?: ApiDispatchTimingDimensions,
  ): void {
    this.records.push({
      actionType,
      spanKind,
      durationMs: Math.max(0, finishedAt - startedAt),
      timestamp: new Date(finishedAt).toISOString(),
      dimensions,
    });
  }

  async measure<T>(
    actionType: ApiDispatchTimingActionType,
    spanKind: ApiDispatchTimingSpanKind,
    operation: () => T | Promise<T>,
    dimensions?: ApiDispatchTimingDimensions,
  ): Promise<T> {
    const startedAt = now();
    const result = await onRejection(
      (async () => {
        return await operation();
      })(),
      () => {
        this.recordElapsed(actionType, spanKind, startedAt, now(), dimensions);
      },
    );
    this.recordElapsed(actionType, spanKind, startedAt, now(), dimensions);
    return result;
  }

  flush(args: {
    readonly runId: string;
    readonly runnerGroup: string;
    readonly profile: string;
    readonly dispatchPath: "direct";
    readonly triggerSource?: TriggerSource;
  }): void {
    const records = this.records.splice(0);
    recordSandboxOperations(
      records.map((record) => {
        return {
          sandboxType: "runner",
          actionType: record.actionType,
          durationMs: record.durationMs,
          success: true,
          runId: args.runId,
          timestamp: record.timestamp,
          dimensions: {
            ...record.dimensions,
            runner_group: args.runnerGroup,
            profile: args.profile,
            dispatch_path: args.dispatchPath,
            span_kind: record.spanKind,
            ...(args.triggerSource
              ? { trigger_source: args.triggerSource }
              : {}),
          },
        };
      }),
    );
  }
}

export async function measureApiDispatchTiming<T>(
  collector: ApiDispatchTimingCollector | undefined,
  actionType: ApiDispatchTimingActionType,
  spanKind: ApiDispatchTimingSpanKind,
  operation: () => T | Promise<T>,
  dimensions?: ApiDispatchTimingDimensions,
): Promise<T> {
  if (!collector) {
    return await operation();
  }
  return await collector.measure(actionType, spanKind, operation, dimensions);
}
