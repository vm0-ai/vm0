-- Custom model gateways used to be recorded under the provider type of an
-- unrelated vendor, so stored telemetry named Vercel for runs that never
-- reached it. Reclassify the historical rows onto the dedicated custom types.
--
-- The predicate must key off `model_provider_surfaces` membership, not the
-- nullability of `model_provider_id`: that column also carries legacy
-- `model_providers` ids for genuine Vercel AI Gateway BYOK connections, which
-- keep their vendor type. Rows whose id matches neither table cannot have their
-- route determined and are deliberately left untouched.
UPDATE "agent_runs"
SET "model_provider" = 'custom-anthropic-messages'
WHERE "model_provider" = 'vercel-ai-gateway'
	AND "model_provider_id" IN (SELECT "id" FROM "model_provider_surfaces");--> statement-breakpoint
UPDATE "agent_runs"
SET "model_provider" = 'custom-openai-responses'
WHERE "model_provider" = 'vercel-ai-gateway-codex'
	AND "model_provider_id" IN (SELECT "id" FROM "model_provider_surfaces");--> statement-breakpoint
-- `org_model_policies` keeps the two routes in separate columns, guarded by
-- `chk_org_model_policies_one_route_id`, so surface routing is unambiguous.
-- No row matches today; the statements exist so future custom-gateway policies
-- written before this deploy are reclassified consistently.
UPDATE "org_model_policies"
SET "default_provider_type" = 'custom-anthropic-messages'
WHERE "default_provider_type" = 'vercel-ai-gateway'
	AND "model_provider_surface_id" IS NOT NULL;--> statement-breakpoint
UPDATE "org_model_policies"
SET "default_provider_type" = 'custom-openai-responses'
WHERE "default_provider_type" = 'vercel-ai-gateway-codex'
	AND "model_provider_surface_id" IS NOT NULL;
