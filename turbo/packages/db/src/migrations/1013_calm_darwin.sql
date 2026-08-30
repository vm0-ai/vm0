ALTER TABLE "agent_runs" ADD COLUMN "official_workflow_provenance" jsonb;--> statement-breakpoint
ALTER TABLE "chat_events" ADD COLUMN "required_official_workflow_ids" uuid[];--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_official_workflow_provenance_check" CHECK ((
          "agent_runs"."official_workflow_provenance" IS NULL OR (
            jsonb_typeof("agent_runs"."official_workflow_provenance") = 'object' AND
            "agent_runs"."official_workflow_provenance" ?& ARRAY[
              'schemaVersion',
              'definitions'
            ] AND
            (
              "agent_runs"."official_workflow_provenance" -
              'schemaVersion' -
              'definitions'
            ) = '{}'::jsonb AND
            "agent_runs"."official_workflow_provenance" -> 'schemaVersion' = '1'::jsonb AND
            jsonb_typeof(
              "agent_runs"."official_workflow_provenance" -> 'definitions'
            ) = 'array' AND
            jsonb_array_length(
              "agent_runs"."official_workflow_provenance" -> 'definitions'
            ) > 0 AND
            NOT jsonb_path_exists(
              "agent_runs"."official_workflow_provenance",
              '$.definitions[*] ? (
                @.type() != "object" ||
                !exists(@.name) ||
                @.name.type() != "string" ||
                !(@.name like_regex "^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$") ||
                !exists(@.revision) ||
                @.revision.type() != "string" ||
                !(@.revision like_regex "^[0-9a-f]{64}$") ||
                !exists(@.artifact) ||
                @.artifact.type() != "object" ||
                exists(
                  @.keyvalue() ? (
                    @.key != "name" &&
                    @.key != "revision" &&
                    @.key != "artifact"
                  )
                ) ||
                !exists(@.artifact.orgId) ||
                @.artifact.orgId != "__system__" ||
                !exists(@.artifact.userId) ||
                @.artifact.userId != "__org__" ||
                !exists(@.artifact.storageName) ||
                @.artifact.storageName.type() != "string" ||
                !(@.artifact.storageName like_regex "^.{1,255}.?$") ||
                !exists(@.artifact.storageId) ||
                @.artifact.storageId.type() != "string" ||
                !(@.artifact.storageId like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$") ||
                !exists(@.artifact.storageVersion) ||
                @.artifact.storageVersion.type() != "string" ||
                !(@.artifact.storageVersion like_regex "^[0-9a-f]{64}$") ||
                exists(
                  @.artifact.keyvalue() ? (
                    @.key != "orgId" &&
                    @.key != "userId" &&
                    @.key != "storageName" &&
                    @.key != "storageId" &&
                    @.key != "storageVersion"
                  )
                )
              )'
            )
          )
        ));--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_official_workflow_queue_claim_check" CHECK ("chat_events"."required_official_workflow_ids" IS NULL OR (
          "chat_events"."event_type" = 'input.prompt'
          AND cardinality("chat_events"."required_official_workflow_ids") > 0
        ));