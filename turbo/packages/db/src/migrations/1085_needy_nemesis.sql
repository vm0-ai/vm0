CREATE TABLE "agent_ssh_access" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_ssh_access_pkey" PRIMARY KEY("org_id","user_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "ssh_connection_credentials" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"encrypted_passphrase" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssh_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" varchar(128) NOT NULL,
	"host" varchar(253) NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" varchar(255) NOT NULL,
	"learned_host_key_algorithm" varchar(64),
	"learned_host_key_fingerprint" varchar(64),
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_ssh_connections_display_name" CHECK (char_length("ssh_connections"."display_name") BETWEEN 1 AND 128),
	CONSTRAINT "chk_ssh_connections_host" CHECK (char_length("ssh_connections"."host") BETWEEN 1 AND 253),
	CONSTRAINT "chk_ssh_connections_port" CHECK ("ssh_connections"."port" BETWEEN 1 AND 65535),
	CONSTRAINT "chk_ssh_connections_username" CHECK (char_length("ssh_connections"."username") BETWEEN 1 AND 255),
	CONSTRAINT "chk_ssh_connections_generation" CHECK ("ssh_connections"."generation" > 0),
	CONSTRAINT "chk_ssh_connections_learned_host_key_pair" CHECK (("ssh_connections"."learned_host_key_algorithm" IS NULL) = ("ssh_connections"."learned_host_key_fingerprint" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "ssh_connection_credentials" ADD CONSTRAINT "ssh_connection_credentials_connection_id_ssh_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ssh_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_ssh_access_agent" ON "agent_ssh_access" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ssh_connections_owner_host_port" ON "ssh_connections" USING btree ("org_id","user_id","host","port");--> statement-breakpoint
CREATE INDEX "idx_ssh_connections_owner_created" ON "ssh_connections" USING btree ("org_id","user_id","created_at","id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "idx_agents_id_org_owner" UNIQUE("id","org_id","owner");