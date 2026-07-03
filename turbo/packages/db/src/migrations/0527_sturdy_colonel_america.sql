ALTER TABLE "blobs" RENAME COLUMN "size" TO "raw_size";--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "encoded_size" bigint;--> statement-breakpoint
UPDATE "blobs" SET "encoding" = 'identity' WHERE "encoding" IS NULL;--> statement-breakpoint
UPDATE "blobs" SET "encoded_size" = "raw_size" WHERE "encoded_size" IS NULL;--> statement-breakpoint
ALTER TABLE "blobs" ALTER COLUMN "encoding" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "blobs" ALTER COLUMN "encoded_size" SET NOT NULL;
