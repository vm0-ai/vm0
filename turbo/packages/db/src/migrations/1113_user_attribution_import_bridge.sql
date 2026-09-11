CREATE TABLE "user_acquisition_delivery_imports" (
	"user_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"latest" jsonb NOT NULL,
	"accepted" jsonb,
	"conflict" boolean DEFAULT false NOT NULL,
	"source_updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "user_acquisition_delivery_imports_user_id_transaction_id_pk" PRIMARY KEY("user_id","transaction_id")
);
--> statement-breakpoint
CREATE TABLE "user_attribution_backfill_checkpoints" (
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_attribution_backfill_checkpoints_run_id_user_id_pk" PRIMARY KEY("run_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "user_attribution_import_snapshots" (
	"user_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"source_updated_at" timestamp (3) with time zone NOT NULL,
	"source" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_attribution_import_snapshots_user_id_fingerprint_pk" PRIMARY KEY("user_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "user_attribution_imports" (
	"user_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"first_touch" jsonb NOT NULL,
	"source_updated_at" timestamp (3) with time zone NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "user_attribution_backfill_user_idx" ON "user_attribution_backfill_checkpoints" USING btree ("user_id");