ALTER TABLE "scopes" ADD COLUMN "default_agent_compose_id" uuid;

DO $$ BEGIN
  ALTER TABLE "scopes"
    ADD CONSTRAINT "scopes_default_agent_compose_id_agent_composes_id_fk"
    FOREIGN KEY ("default_agent_compose_id")
    REFERENCES "public"."agent_composes"("id")
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;