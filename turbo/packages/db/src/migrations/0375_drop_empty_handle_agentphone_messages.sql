-- Backfill for the iMessage-email-handle bug fixed in PR for #13200.
-- Inbound iMessages from email-form Apple IDs were stored with
-- phone_handle = '' (and from_number = '') because the legacy phone-only
-- normalize stripped away the email. Those rows are orphaned (no user link
-- could ever resolve) and would otherwise pollute the
-- (phone_handle, created_at) index with a single empty-string bucket.
DELETE FROM "agentphone_messages"
 WHERE "phone_handle" = ''
   AND "agentphone_user_link_id" IS NULL;