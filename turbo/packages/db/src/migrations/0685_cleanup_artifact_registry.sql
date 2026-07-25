-- `artifacts.entity_id` is polymorphic, so PostgreSQL cannot express its
-- ownership with one foreign key. Keep the registry row lifecycle atomic with
-- each kind entity instead: deleting any backing entity removes its catalog
-- row in the same transaction.
CREATE FUNCTION "delete_artifact_registry_entity"() RETURNS trigger AS $$
BEGIN
  DELETE FROM "artifacts"
  WHERE "kind" = TG_ARGV[0]
    AND "entity_id" = OLD."id";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "run_uploaded_files_delete_artifact_registry"
AFTER DELETE ON "run_uploaded_files"
FOR EACH ROW EXECUTE FUNCTION "delete_artifact_registry_entity"('file');--> statement-breakpoint

CREATE TRIGGER "hosted_sites_delete_artifact_registry"
AFTER DELETE ON "hosted_sites"
FOR EACH ROW EXECUTE FUNCTION "delete_artifact_registry_entity"('hosted-site');--> statement-breakpoint

CREATE TRIGGER "image_artifacts_delete_artifact_registry"
AFTER DELETE ON "image_artifacts"
FOR EACH ROW EXECUTE FUNCTION "delete_artifact_registry_entity"('image');--> statement-breakpoint

CREATE TRIGGER "video_artifacts_delete_artifact_registry"
AFTER DELETE ON "video_artifacts"
FOR EACH ROW EXECUTE FUNCTION "delete_artifact_registry_entity"('video');--> statement-breakpoint

CREATE TRIGGER "presentation_artifacts_delete_artifact_registry"
AFTER DELETE ON "presentation_artifacts"
FOR EACH ROW EXECUTE FUNCTION "delete_artifact_registry_entity"('presentation');
