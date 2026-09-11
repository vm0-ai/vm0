CREATE TABLE "privacy_choice_revisions" (
	"revision" uuid PRIMARY KEY NOT NULL,
	"subject_id" uuid NOT NULL,
	"sale_sharing" text NOT NULL,
	"advertising" text NOT NULL,
	"marketing_analytics" text NOT NULL,
	"source" text NOT NULL,
	"policy_version" text NOT NULL,
	"recorded_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_choices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"token_hash" text,
	"linked_user_id" text,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"sale_sharing" text DEFAULT 'unknown' NOT NULL,
	"advertising" text DEFAULT 'unknown' NOT NULL,
	"marketing_analytics" text DEFAULT 'unknown' NOT NULL,
	"source" text,
	"policy_version" text NOT NULL,
	"updated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_choices_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "privacy_choices_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "privacy_choices_owner_check" CHECK (("privacy_choices"."user_id" IS NOT NULL AND "privacy_choices"."token_hash" IS NULL AND "privacy_choices"."linked_user_id" IS NULL) OR ("privacy_choices"."user_id" IS NULL AND "privacy_choices"."token_hash" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "privacy_choice_revisions" ADD CONSTRAINT "privacy_choice_revisions_subject_id_privacy_choices_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."privacy_choices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "privacy_choice_revisions_subject_idx" ON "privacy_choice_revisions" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "privacy_choices_linked_user_idx" ON "privacy_choices" USING btree ("linked_user_id");