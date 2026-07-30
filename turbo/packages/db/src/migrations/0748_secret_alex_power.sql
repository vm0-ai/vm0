CREATE TABLE "github_chat_thread_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"repo" varchar(255) NOT NULL,
	"subject_number" integer NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"last_comment_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_chat_thread_routes" ADD CONSTRAINT "github_chat_thread_routes_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_chat_thread_routes" ADD CONSTRAINT "github_chat_thread_routes_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_chat_thread_routes_install_repo_subject_user" ON "github_chat_thread_routes" USING btree ("installation_id","repo","subject_number","user_id");
