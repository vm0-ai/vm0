ALTER TABLE "presentation_templates" DROP CONSTRAINT "chk_presentation_templates_status";--> statement-breakpoint
ALTER TABLE "presentation_templates" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "presentation_templates" DROP COLUMN "error";