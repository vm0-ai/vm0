ALTER TABLE "mail_drafts" DROP CONSTRAINT "mail_drafts_follow_up_automation_id_zero_workflow_automations_id_fk";
--> statement-breakpoint
DROP INDEX "idx_mail_drafts_follow_up_automation";--> statement-breakpoint
ALTER TABLE "mail_drafts" DROP COLUMN "follow_up_automation_id";