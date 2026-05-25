ALTER TABLE "variables" DROP CONSTRAINT "variables_scope_id_scopes_id_fk";
--> statement-breakpoint
DROP INDEX "idx_variables_scope_user_name";--> statement-breakpoint
DROP INDEX "idx_variables_scope";