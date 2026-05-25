-- Unify roles: rename 'owner' to 'admin' (align with Clerk's org:admin convention)
UPDATE "scope_members" SET "role" = 'admin' WHERE "role" = 'owner';--> statement-breakpoint
ALTER TABLE "scope_members" ADD CONSTRAINT "scope_members_role_check" CHECK ("scope_members"."role" IN ('admin', 'member'));