ALTER TABLE "agent_composes" ALTER COLUMN "scope_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "scope_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_schedules" ALTER COLUMN "scope_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ALTER COLUMN "scope_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ALTER COLUMN "scope_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" ALTER COLUMN "scope_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "storages" ALTER COLUMN "scope_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "variables" ALTER COLUMN "scope_id" DROP NOT NULL;