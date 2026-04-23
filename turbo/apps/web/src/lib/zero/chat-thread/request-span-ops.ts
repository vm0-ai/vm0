/**
 * Canonical op_type strings emitted to the `sandbox-op-log` Axiom dataset
 * with `source: "web-chat"` by the `/api/zero/chat/messages` route handler
 * and its service-layer sub-stages. Centralized so emitters and query authors
 * share a single source of truth and typos can't drift between them.
 */
export const CHAT_REQUEST_OPS = {
  auth: "api_chat_send_auth",
  agent_lookup: "api_chat_send_agent_lookup",
  model_selection_validate: "api_chat_send_model_selection_validate",
  model_selection_lock_check: "api_chat_send_model_selection_lock_check",
  resolve_thread_create_thread: "api_chat_send_resolve_thread_create_thread",
  resolve_thread_get_thread: "api_chat_send_resolve_thread_get_thread",
  resolve_thread_session_id: "api_chat_send_resolve_thread_session_id",
  resolve_thread_get_messages: "api_chat_send_resolve_thread_get_messages",
  resolve_thread_has_any_run: "api_chat_send_resolve_thread_has_any_run",
  resolve_thread_incomplete: "api_chat_send_resolve_thread_incomplete",
  resolve_thread_continue_from: "api_chat_send_resolve_thread_continue_from",
  resolve_model_override: "api_chat_send_resolve_model_override",
  create_run_round1_agent: "api_chat_send_create_run_round1_agent",
  create_run_round1_compose: "api_chat_send_create_run_round1_compose",
  create_run_round1_cached_user: "api_chat_send_create_run_round1_cached_user",
  create_run_round2_connectors: "api_chat_send_create_run_round2_connectors",
  create_run_round2_custom_connectors:
    "api_chat_send_create_run_round2_custom_connectors",
  create_run_round2_org_meta: "api_chat_send_create_run_round2_org_meta",
  create_run_round2_user_prefs: "api_chat_send_create_run_round2_user_prefs",
  create_run_round2_feature_sw: "api_chat_send_create_run_round2_feature_sw",
  create_run_round2_load_compose:
    "api_chat_send_create_run_round2_load_compose",
  create_run_round3_credits: "api_chat_send_create_run_round3_credits",
  create_run_round3_model_provider:
    "api_chat_send_create_run_round3_model_provider",
  create_run_round3_capture: "api_chat_send_create_run_round3_capture",
  create_run_advisory_lock: "api_chat_send_create_run_advisory_lock",
  create_run_concurrency_check: "api_chat_send_create_run_concurrency_check",
  create_run_insert_run_record: "api_chat_send_create_run_insert_run_record",
  persist_zero_run_metadata: "api_chat_send_persist_zero_run_metadata",
  insert_chat_message_insert: "api_chat_send_insert_chat_message_insert",
  insert_chat_message_publish_signal:
    "api_chat_send_insert_chat_message_publish_signal",
  insert_chat_message_publish_list:
    "api_chat_send_insert_chat_message_publish_list",
  title_context_fetch: "api_chat_send_title_context_fetch",
} as const;

/**
 * Wrap a promise-returning function with a wall-clock timer. Returns the
 * function's result alongside the elapsed duration in milliseconds.
 */
export async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - start };
}
