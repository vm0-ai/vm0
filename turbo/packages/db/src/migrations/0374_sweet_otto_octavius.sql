ALTER TABLE "agentphone_messages" ALTER COLUMN "phone_handle" SET DATA TYPE varchar(254);--> statement-breakpoint
ALTER TABLE "agentphone_messages" ALTER COLUMN "from_number" SET DATA TYPE varchar(254);--> statement-breakpoint
ALTER TABLE "agentphone_messages" ALTER COLUMN "to_number" SET DATA TYPE varchar(254);--> statement-breakpoint
ALTER TABLE "agentphone_user_links" ALTER COLUMN "phone_handle" SET DATA TYPE varchar(254);