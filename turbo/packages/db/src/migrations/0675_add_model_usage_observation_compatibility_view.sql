-- Custom SQL migration file, put your code below! --
CREATE VIEW "compact_model_usage_observation" AS
SELECT
  "idempotency_key",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "observed_at"
FROM "model_usage_observation";
