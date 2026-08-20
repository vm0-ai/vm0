SET LOCAL lock_timeout = '5s';--> statement-breakpoint
LOCK TABLE "usage_pack_subscriptions" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
CREATE TABLE "usage_pack_pending_snapshot_guards" (
	"org_id" text NOT NULL,
	"pending_snapshot_count" integer NOT NULL,
	CONSTRAINT "chk_usage_pack_pending_snapshot_guard_count" CHECK ("usage_pack_pending_snapshot_guards"."pending_snapshot_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_subscriptions_pending_org" ON "usage_pack_pending_snapshot_guards" USING btree ("org_id");--> statement-breakpoint

-- Old API revisions can leave more than one pending snapshot for an
-- organization. Preserve the exact count without deleting those rows or losing
-- their Stripe Session correlation; the current API reconciles and expires
-- every competing Session before the count can return to zero.
INSERT INTO "usage_pack_pending_snapshot_guards" (
  "org_id",
  "pending_snapshot_count"
)
SELECT
  "org_id",
  count(*)::integer
FROM "usage_pack_subscriptions"
WHERE "subscription_status" IN ('checkout_pending', 'purchase_pending')
GROUP BY "org_id";--> statement-breakpoint

-- This trigger is the DB/API rollout bridge for #28304. It makes the seeded
-- count converge atomically while old and new API revisions may coexist. In
-- #28372, after the API rollback/drain window and every pre-0952 pending
-- snapshot/Session have been reconciled, replace this bridge with the direct
-- partial unique index and drop the guard objects.
CREATE FUNCTION "sync_usage_pack_pending_snapshot_guard_0952"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_rows integer;
  should_claim boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."subscription_status" IN ('checkout_pending', 'purchase_pending') THEN
      UPDATE "usage_pack_pending_snapshot_guards"
      SET "pending_snapshot_count" = "pending_snapshot_count" - 1
      WHERE "org_id" = OLD."org_id"
        AND "pending_snapshot_count" > 0;
      GET DIAGNOSTICS affected_rows = ROW_COUNT;
      IF affected_rows = 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'usage-pack pending snapshot guard count is missing',
          CONSTRAINT = 'chk_usage_pack_pending_snapshot_guard_count';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    should_claim := NEW."subscription_status" IN ('checkout_pending', 'purchase_pending');
  ELSE
    IF OLD."subscription_status" IN ('checkout_pending', 'purchase_pending')
      AND (
        NEW."subscription_status" NOT IN ('checkout_pending', 'purchase_pending')
        OR OLD."org_id" IS DISTINCT FROM NEW."org_id"
      )
    THEN
      UPDATE "usage_pack_pending_snapshot_guards"
      SET "pending_snapshot_count" = "pending_snapshot_count" - 1
      WHERE "org_id" = OLD."org_id"
        AND "pending_snapshot_count" > 0;
      GET DIAGNOSTICS affected_rows = ROW_COUNT;
      IF affected_rows = 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'usage-pack pending snapshot guard count is missing',
          CONSTRAINT = 'chk_usage_pack_pending_snapshot_guard_count';
      END IF;
    END IF;
    should_claim := NEW."subscription_status" IN ('checkout_pending', 'purchase_pending')
      AND (
        OLD."subscription_status" NOT IN ('checkout_pending', 'purchase_pending')
        OR OLD."org_id" IS DISTINCT FROM NEW."org_id"
      );
  END IF;

  IF should_claim THEN
    INSERT INTO "usage_pack_pending_snapshot_guards" (
      "org_id",
      "pending_snapshot_count"
    )
    VALUES (NEW."org_id", 1)
    ON CONFLICT ("org_id") DO UPDATE
    SET "pending_snapshot_count" = 1
    WHERE "usage_pack_pending_snapshot_guards"."pending_snapshot_count" = 0;
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'another usage-pack purchase is already pending for this organization',
        CONSTRAINT = 'uq_usage_pack_subscriptions_pending_org';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "sync_usage_pack_pending_snapshot_guard_0952"
AFTER INSERT OR DELETE OR UPDATE OF "org_id", "subscription_status"
ON "usage_pack_subscriptions"
FOR EACH ROW
EXECUTE FUNCTION "sync_usage_pack_pending_snapshot_guard_0952"();
