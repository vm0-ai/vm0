ALTER TABLE "zero_workflows" ADD COLUMN "updated_by" text;

UPDATE "zero_workflows"
SET "updated_by" = "created_by";

ALTER TABLE "zero_workflows" ALTER COLUMN "updated_by" SET NOT NULL;
