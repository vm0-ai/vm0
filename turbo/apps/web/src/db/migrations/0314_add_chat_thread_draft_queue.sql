-- Add draft_queue JSONB column to chat_threads to persist client-side message
-- queue state across page refreshes. Each row is { text: string }.
ALTER TABLE "chat_threads" ADD COLUMN "draft_queue" jsonb;
