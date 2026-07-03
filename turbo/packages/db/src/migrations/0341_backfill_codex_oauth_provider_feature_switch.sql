-- Rename the staff feature-switch JSONB key from `chatgptOauthProvider` to
-- `codexOauthProvider` to match the wire-format rename in #11990 (commit
-- f17849a17). Without this backfill, any existing override row with
-- `{"chatgptOauthProvider": <bool>}` becomes a stranger key after the rename
-- and the new code path silently falls back to the static default.
--
-- The switch is staff-only (`enabledOrgIdHashes: STAFF_ORG_ID_HASHES`), so the
-- expected row count is small. A read-only prod check at PR-review time
-- found exactly 1 affected row.
UPDATE user_feature_switches
SET switches = (switches - 'chatgptOauthProvider')
            || jsonb_build_object('codexOauthProvider', switches->'chatgptOauthProvider'),
    updated_at = NOW()
WHERE switches ? 'chatgptOauthProvider';
