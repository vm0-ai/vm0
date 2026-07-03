-- Remove openai-api-key model providers (no longer supported via model-provider setup)
-- Associated credentials will be cascade deleted due to FK constraint on model_providers.credentialId
DELETE FROM model_providers WHERE type = 'openai-api-key';
