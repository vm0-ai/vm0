CREATE TABLE "canonical_asset_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"operation_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"destination" jsonb NOT NULL,
	"external_id" text,
	"url" text,
	"last_error" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_message_asset_refs" (
	"chat_message_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_asset_refs_pk" PRIMARY KEY("chat_message_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "chat_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "asset_version" integer;--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "classification" varchar(32);--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "access_level" varchar(16);--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "materialization_status" varchar(16);--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "checksum_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "materialization_error" jsonb;--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "idempotency_scope" text;--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "canonical_asset_deliveries" ADD CONSTRAINT "canonical_asset_deliveries_asset_id_run_uploaded_files_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."run_uploaded_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_asset_refs" ADD CONSTRAINT "chat_message_asset_refs_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_asset_refs" ADD CONSTRAINT "chat_message_asset_refs_asset_id_run_uploaded_files_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."run_uploaded_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_asset_deliveries_asset_provider_operation_unique" ON "canonical_asset_deliveries" USING btree ("asset_id","provider","operation_id");--> statement-breakpoint
CREATE INDEX "canonical_asset_deliveries_asset_idx" ON "canonical_asset_deliveries" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_asset_refs_message_position_unique" ON "chat_message_asset_refs" USING btree ("chat_message_id","position");--> statement-breakpoint
CREATE INDEX "chat_message_asset_refs_asset_idx" ON "chat_message_asset_refs" USING btree ("asset_id");--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD CONSTRAINT "run_uploaded_files_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_uploaded_files_canonical_idempotency_unique" ON "run_uploaded_files" USING btree ("user_id","idempotency_scope","idempotency_key") WHERE "run_uploaded_files"."asset_version" = 1;--> statement-breakpoint
CREATE INDEX "run_uploaded_files_chat_thread_idx" ON "run_uploaded_files" USING btree ("chat_thread_id") WHERE "run_uploaded_files"."chat_thread_id" IS NOT NULL;