DROP INDEX "uq_user_permission_grants_grant";--> statement-breakpoint
ALTER TABLE "user_permission_grants" ADD COLUMN "target_type" varchar(32) DEFAULT 'permission' NOT NULL;--> statement-breakpoint
UPDATE "user_permission_grants" SET "target_type" = 'unknown-endpoint', "permission" = '' WHERE "permission" = '__unknown__';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_permission_grants_target" ON "user_permission_grants" USING btree ("org_id","user_id","agent_id","connector_ref","target_type") WHERE target_type IN ('connector-default', 'unknown-endpoint');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_permission_grants_grant" ON "user_permission_grants" USING btree ("org_id","user_id","agent_id","connector_ref","permission") WHERE target_type = 'permission';--> statement-breakpoint
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "chk_user_permission_grants_target_type" CHECK ("user_permission_grants"."target_type" IN ('permission', 'connector-default', 'unknown-endpoint'));--> statement-breakpoint
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "chk_user_permission_grants_target_permission" CHECK (("user_permission_grants"."target_type" = 'permission' AND "user_permission_grants"."permission" <> '') OR ("user_permission_grants"."target_type" <> 'permission' AND "user_permission_grants"."permission" = ''));
