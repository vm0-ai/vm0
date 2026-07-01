CREATE TABLE "session_history_blob_representations" (
	"raw_hash" varchar(64) NOT NULL,
	"encoding" varchar(16) NOT NULL,
	"raw_size" bigint NOT NULL,
	"encoded_size" bigint NOT NULL,
	"object_key" varchar(512) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_history_blob_representations_pkey" PRIMARY KEY("raw_hash","encoding")
);
--> statement-breakpoint
ALTER TABLE "session_history_blob_representations" ADD CONSTRAINT "session_history_blob_representations_raw_hash_blobs_hash_fk" FOREIGN KEY ("raw_hash") REFERENCES "public"."blobs"("hash") ON DELETE cascade ON UPDATE no action;