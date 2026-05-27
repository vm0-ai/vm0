ALTER TABLE "variables" ADD COLUMN "type" varchar(50) DEFAULT 'user' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_variables_org_user_type_name" ON "variables" USING btree ("org_id","user_id","type","name");--> statement-breakpoint
DROP INDEX "idx_variables_org_user_name";
