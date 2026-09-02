import { z } from "zod";

export const runFailureReasonSchema = z.enum([
  "session_history_limit",
  "insufficient_credits",
  "invalid_api_key",
  "invalid_credentials",
  "terms_acceptance_required",
  "context_window_exceeded",
  "output_token_limit",
  "provider_rate_limited",
  "provider_overloaded",
  "provider_stream_timeout",
  "provider_server_error",
  "response_connection_lost",
  "safety_policy_refusal",
  "reconnect_required",
  "unsupported_model",
  "usage_limit",
]);

export type RunFailureReason = z.infer<typeof runFailureReasonSchema>;
