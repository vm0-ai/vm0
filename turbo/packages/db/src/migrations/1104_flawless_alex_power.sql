CREATE TABLE "ssh_connection_observations" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"failure_reason" varchar(64),
	CONSTRAINT "chk_ssh_connection_observation_generation" CHECK ("ssh_connection_observations"."generation" > 0),
	CONSTRAINT "chk_ssh_connection_observation_failure" CHECK ("ssh_connection_observations"."failure_reason" IS NULL OR "ssh_connection_observations"."failure_reason" IN ('invalid_credential', 'unsupported_credential', 'credential_resource_limit', 'unsafe_destination', 'network_failure', 'host_key_mismatch', 'unsupported_host_key', 'authentication_failed', 'protocol', 'timed_out'))
);
--> statement-breakpoint
ALTER TABLE "ssh_connection_observations" ADD CONSTRAINT "ssh_connection_observations_connection_id_ssh_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ssh_connections"("id") ON DELETE cascade ON UPDATE no action;