CREATE TABLE "active_input_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	CONSTRAINT "active_input_deliveries_status_check" CHECK ("active_input_deliveries"."status" IN ('open', 'settled'))
);
--> statement-breakpoint
CREATE TABLE "active_input_delivery_items" (
	"delivery_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"disposition" text,
	CONSTRAINT "active_input_delivery_items_delivery_id_source_event_id_pk" PRIMARY KEY("delivery_id","source_event_id"),
	CONSTRAINT "active_input_delivery_items_position_check" CHECK ("active_input_delivery_items"."position" >= 0),
	CONSTRAINT "active_input_delivery_items_disposition_check" CHECK ("active_input_delivery_items"."disposition" IS NULL OR "active_input_delivery_items"."disposition" IN ('delivered', 'released', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "active_input_deliveries" ADD CONSTRAINT "active_input_deliveries_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_input_deliveries" ADD CONSTRAINT "active_input_deliveries_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_input_delivery_items" ADD CONSTRAINT "active_input_delivery_items_delivery_id_active_input_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."active_input_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_input_delivery_items" ADD CONSTRAINT "active_input_delivery_items_source_event_id_chat_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."chat_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "active_input_deliveries_run_open_unique" ON "active_input_deliveries" USING btree ("run_id") WHERE "active_input_deliveries"."status" = 'open';--> statement-breakpoint
CREATE INDEX "active_input_deliveries_thread_open_idx" ON "active_input_deliveries" USING btree ("chat_thread_id") WHERE "active_input_deliveries"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "active_input_delivery_items_delivery_position_unique" ON "active_input_delivery_items" USING btree ("delivery_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "active_input_delivery_items_source_open_unique" ON "active_input_delivery_items" USING btree ("source_event_id") WHERE "active_input_delivery_items"."disposition" IS NULL;