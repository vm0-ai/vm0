import { z } from "zod";

/**
 * Maximum file size per file in bytes (100MB).
 */
export const MAX_FILE_SIZE_BYTES = 104_857_600;

/**
 * File entry with hash for content-addressable storage.
 */
export const fileEntryWithHashSchema = z.object({
  path: z.string().min(1, "File path is required"),
  hash: z.string().length(64, "Hash must be SHA-256 (64 hex chars)"),
  size: z
    .number()
    .int()
    .min(0, "Size must be non-negative")
    .max(MAX_FILE_SIZE_BYTES, "File size exceeds 100MB limit"),
});

/**
 * Incremental changes for partial uploads.
 */
export const storageChangesSchema = z.object({
  added: z.array(z.string()),
  modified: z.array(z.string()),
  deleted: z.array(z.string()),
});

/**
 * Presigned upload URL.
 */
export const presignedUploadSchema = z.object({
  key: z.string(),
  presignedUrl: z.url(),
});
