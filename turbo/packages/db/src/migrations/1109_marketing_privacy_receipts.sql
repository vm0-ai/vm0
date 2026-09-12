CREATE TABLE "marketing_privacy_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"privacy_revision" uuid NOT NULL,
	"advertising_epoch" uuid,
	"marketing_analytics_epoch" uuid,
	"policy_version" text NOT NULL,
	"captured_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "privacy_choices" ADD COLUMN "advertising_epoch" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy_choices" ADD COLUMN "marketing_analytics_epoch" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_privacy_receipts" ADD CONSTRAINT "marketing_privacy_receipts_subject_id_privacy_choices_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."privacy_choices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_privacy_receipts" ADD CONSTRAINT "marketing_privacy_receipts_privacy_revision_privacy_choice_revisions_revision_fk" FOREIGN KEY ("privacy_revision") REFERENCES "public"."privacy_choice_revisions"("revision") ON DELETE cascade ON UPDATE no action;