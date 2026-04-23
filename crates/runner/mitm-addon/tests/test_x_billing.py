"""Unit tests for :mod:`usage.providers.connectors.x_billing`.

Each public function gets dedicated coverage so a regression in the
classifier surface is caught without relying on the broader billing
pipeline tests in ``test_handlers.py``.
"""

from __future__ import annotations

import json
import pathlib
import re

import pytest

from usage.providers.connectors.x_billing import (
    _INCLUDES_TO_BUCKET,
    _PATH_OVERRIDES,
    _PERMISSION_TO_BUCKET,
    classify_bucket,
    classify_includes_bucket,
    refine_bucket_with_body,
)


class TestClassifyBucket:
    """``classify_bucket(permission, method, path) -> bucket | None``."""

    @pytest.mark.parametrize(
        ("permission", "method", "path", "expected"),
        [
            # — clean 1:1 writes —
            ("tweet.moderate.write", "PUT", "/2/tweets/1/hidden", "content.manage"),
            ("bookmark.write", "POST", "/2/users/me/bookmarks", "bookmark"),
            ("dm.write", "POST", "/2/dm_events", "dm_interaction.create"),
            # — clean 1:1 reads —
            ("dm.read", "GET", "/2/dm_events", "dm_event.read"),
            ("follows.read", "GET", "/2/users/1/followers", "following_followers.read"),
            ("like.read", "GET", "/2/tweets/1/liking_users", "posts.read"),
            ("timeline.read", "GET", "/2/users/1/timelines/reverse_chronological", "posts.read"),
            ("space.read", "GET", "/2/spaces/1", "space.read"),
            ("list.read", "GET", "/2/lists/1", "list.read"),
            ("block.read", "GET", "/2/users/me/blocking", "user.read"),
            ("mute.read", "GET", "/2/users/me/muting", "user.read"),
            ("bookmark.read", "GET", "/2/users/me/bookmarks", "posts.read"),
            # — multi-bucket scopes default to the conservative bucket —
            ("tweet.write", "POST", "/2/tweets", "content.create_with_url"),
            ("media.write", "POST", "/2/media/upload", "content.create_with_url"),
            ("like.write", "POST", "/2/users/me/likes", "user_interaction.create"),
            ("follows.write", "POST", "/2/users/me/following", "user_interaction.create"),
            ("mute.write", "POST", "/2/users/me/muting", "user_interaction.create"),
            ("list.write", "POST", "/2/lists", "list.create"),
            ("tweet.read", "GET", "/2/tweets", "posts.read"),
            ("users.read", "GET", "/2/users/1", "user.read"),
        ],
    )
    def test_defaults(self, permission, method, path, expected):
        assert classify_bucket(permission, method, path) == expected

    @pytest.mark.parametrize(
        ("permission", "method", "path", "expected"),
        [
            # — tweet.read refinements —
            ("tweet.read", "GET", "/2/tweets/1/retweeted_by", "user.read"),
            ("tweet.read", "GET", "/2/insights/28hr", "analytics.read"),
            ("tweet.read", "GET", "/2/insights/historical", "analytics.read"),
            ("tweet.read", "GET", "/2/media/analytics", "analytics.read"),
            ("tweet.read", "GET", "/2/tweets/analytics", "analytics.read"),
            ("tweet.read", "GET", "/2/media", "media.read"),
            ("tweet.read", "GET", "/2/media/abc", "media.read"),
            ("tweet.read", "GET", "/2/notes/search/notes_written", "note.read"),
            ("tweet.read", "GET", "/2/notes/search/posts_eligible_for_notes", "note.read"),
            # — users.read refinements —
            ("users.read", "GET", "/2/users/1/mentions", "posts.read"),
            ("users.read", "GET", "/2/users/1/timelines/reverse_chronological", "posts.read"),
            ("users.read", "GET", "/2/users/1/tweets", "posts.read"),
            ("users.read", "GET", "/2/communities/search", "community.read"),
            # — write DELETE → interaction.delete / mute.delete —
            ("like.write", "DELETE", "/2/users/1/likes/2", "interaction.delete"),
            ("follows.write", "DELETE", "/2/users/1/following/2", "interaction.delete"),
            ("mute.write", "DELETE", "/2/users/1/muting/2", "mute.delete"),
            # — list.write refinements: create stays, everything else is manage —
            ("list.write", "PUT", "/2/lists/1", "list.manage"),
            ("list.write", "DELETE", "/2/lists/1", "list.manage"),
            ("list.write", "POST", "/2/lists/1/members", "list.manage"),
            ("list.write", "DELETE", "/2/lists/1/members/2", "list.manage"),
            ("list.write", "POST", "/2/users/1/followed_lists", "list.manage"),
            ("list.write", "DELETE", "/2/users/1/followed_lists/2", "list.manage"),
            ("list.write", "POST", "/2/users/1/pinned_lists", "list.manage"),
            ("list.write", "DELETE", "/2/users/1/pinned_lists/2", "list.manage"),
            # — bookmark DELETE stays on bookmark (not interaction.delete) —
            ("bookmark.write", "DELETE", "/2/users/1/bookmarks/2", "bookmark"),
            # — media.write refinements —
            ("media.write", "GET", "/2/media/upload", "media.read"),
            ("media.write", "GET", "/2/chat/media/abc/xyz", "media.read"),
            ("media.write", "POST", "/2/media/metadata", "media_metadata"),
            ("media.write", "POST", "/2/media/subtitles", "media_metadata"),
            ("media.write", "DELETE", "/2/media/subtitles", "media_metadata"),
            # — media.write: chat (DM) media uploads route to DM bucket —
            (
                "media.write",
                "POST",
                "/2/chat/media/upload/initialize",
                "dm_interaction.create",
            ),
            (
                "media.write",
                "POST",
                "/2/chat/media/upload/abc/append",
                "dm_interaction.create",
            ),
            (
                "media.write",
                "POST",
                "/2/chat/media/upload/abc/finalize",
                "dm_interaction.create",
            ),
            # — tweet.write: DELETE of your own content → Content: Manage —
            ("tweet.write", "DELETE", "/2/tweets/123", "content.manage"),
            ("tweet.write", "DELETE", "/2/notes/abc", "content.manage"),
            # — tweet.write: retweets are User Interaction (create/delete) —
            ("tweet.write", "POST", "/2/users/1/retweets", "user_interaction.create"),
            ("tweet.write", "DELETE", "/2/users/1/retweets/999", "interaction.delete"),
            ("tweet.write", "POST", "/2/evaluate_note", "user_interaction.create"),
            # — dm.write: deleting a DM → Content: Manage —
            ("dm.write", "DELETE", "/2/dm_events/abc", "content.manage"),
        ],
    )
    def test_path_overrides(self, permission, method, path, expected):
        assert classify_bucket(permission, method, path) == expected

    @pytest.mark.parametrize(
        ("permission", "method", "path"),
        [
            # The "app-only" scope is in the firewall but intentionally
            # unmapped here — BearerToken-only endpoints are not billed.
            ("app-only", "GET", "/2/tweets/counts/all"),
            # — any unknown scope falls through —
            ("unknown.scope", "GET", "/anywhere"),
            ("", "GET", "/2/tweets"),
        ],
    )
    def test_returns_none_for_unmapped(self, permission, method, path):
        assert classify_bucket(permission, method, path) is None

    def test_method_is_case_insensitive(self):
        # Override tables store methods uppercased; classifier must match
        # regardless of what the caller passes in.
        assert (
            classify_bucket("like.write", "delete", "/2/users/me/likes/1") == "interaction.delete"
        )
        assert (
            classify_bucket("like.write", "DELETE", "/2/users/me/likes/1") == "interaction.delete"
        )


class TestClassifyIncludesBucket:
    @pytest.mark.parametrize(
        ("key", "expected"),
        [
            ("users", "user.read"),
            ("tweets", "posts.read"),
            ("media", "media.read"),
            ("polls", "posts.read"),
            ("places", "posts.read"),
            ("topics", "posts.read"),
            ("spaces", "space.read"),
        ],
    )
    def test_known_keys(self, key, expected):
        assert classify_includes_bucket(key) == expected

    @pytest.mark.parametrize("key", ["future_widget", "", "users_extended"])
    def test_unknown_keys_return_none(self, key):
        assert classify_includes_bucket(key) is None


class TestRefineBucketWithBody:
    """``refine_bucket_with_body`` only affects POST /2/tweets.
    Everything else flows through unchanged.
    """

    def _body(self, obj: dict) -> bytes:
        return json.dumps(obj).encode()

    # — paths that bypass refinement —

    @pytest.mark.parametrize(
        ("bucket", "method", "path", "body"),
        [
            # Non-target bucket
            ("posts.read", "POST", "/2/tweets", b'{"text": "no url"}'),
            # Non-POST
            ("content.create_with_url", "GET", "/2/tweets", b'{"text": "no url"}'),
            # Non-target path
            (
                "content.create_with_url",
                "POST",
                "/2/tweets/1/hidden",
                b'{"text": "no url"}',
            ),
        ],
    )
    def test_passthrough(self, bucket, method, path, body):
        assert refine_bucket_with_body(bucket, method, path, body) == bucket

    # — POST /2/tweets downgrade path —

    def test_plain_text_downgrades(self):
        body = self._body({"text": "hello world"})
        assert (
            refine_bucket_with_body("content.create_with_url", "POST", "/2/tweets", body)
            == "content.create"
        )

    @pytest.mark.parametrize(
        "text",
        [
            "check https://example.com out",
            "http://legacy.example.com",
            "prefix http://x.co suffix",
        ],
    )
    def test_url_in_text_stays_on_with_url(self, text):
        body = self._body({"text": text})
        assert (
            refine_bucket_with_body("content.create_with_url", "POST", "/2/tweets", body)
            == "content.create_with_url"
        )

    def test_quote_tweet_stays_on_with_url(self):
        body = self._body({"text": "nice", "quote_tweet_id": "abc"})
        assert (
            refine_bucket_with_body("content.create_with_url", "POST", "/2/tweets", body)
            == "content.create_with_url"
        )

    def test_attached_media_stays_on_with_url(self):
        body = self._body({"text": "pic", "media": {"media_ids": ["42"]}})
        assert (
            refine_bucket_with_body("content.create_with_url", "POST", "/2/tweets", body)
            == "content.create_with_url"
        )

    def test_card_uri_stays_on_with_url(self):
        # card_uri attaches a link preview card — the published tweet
        # always renders a URL even if the text is plain.
        body = self._body({"text": "plain", "card_uri": "card://12345"})
        assert (
            refine_bucket_with_body("content.create_with_url", "POST", "/2/tweets", body)
            == "content.create_with_url"
        )

    def test_empty_media_ids_list_allows_downgrade(self):
        body = self._body({"text": "no media", "media": {"media_ids": []}})
        assert (
            refine_bucket_with_body("content.create_with_url", "POST", "/2/tweets", body)
            == "content.create"
        )

    @pytest.mark.parametrize(
        "body",
        [
            None,
            b"",
            b"not json",
            b'["unexpected array"]',
            # Dict without `text`
            b"{}",
            # text is not a string
            b'{"text": 42}',
        ],
    )
    def test_defensive_cases_stay_on_with_url(self, body):
        assert (
            refine_bucket_with_body("content.create_with_url", "POST", "/2/tweets", body)
            == "content.create_with_url"
        )


class TestFirewallConsistency:
    """Every permission group produced by the X firewall generator must
    either have a classifier mapping or appear in the intentionally
    unmapped set.  Without this check, an OpenAPI-driven firewall
    regeneration could introduce a new OAuth scope that silently skips
    billing (``classify_bucket`` returns ``None`` → request not
    recorded).
    """

    # Permission names that the classifier deliberately skips.  Requests
    # matching these scopes do not emit ``usage_event`` rows.
    _INTENTIONALLY_UNMAPPED: frozenset[str] = frozenset({"app-only"})

    def _firewall_block(self) -> str:
        fw_path = (
            pathlib.Path(__file__).resolve().parent.parent.parent.parent.parent
            / "turbo"
            / "packages"
            / "core"
            / "src"
            / "firewalls"
            / "x.generated.ts"
        )
        if not fw_path.exists():
            pytest.fail(
                f"x.generated.ts not found at {fw_path}.\n"
                "This file is generated by the firewall generator's postinstall "
                "hook and is gitignored — run `cd turbo && pnpm install` to "
                "produce it before running these tests.  If the file still "
                "isn't created after install, the generator output path has "
                "likely moved; update this test's path computation."
            )
        text = fw_path.read_text()
        try:
            start = text.index("permissions: [")
        except ValueError:
            pytest.fail(
                "Could not locate the `permissions: [...]` block in "
                f"{fw_path}.  The firewall generator's output shape changed "
                "— update this test."
            )
        pos = start + len("permissions: [")
        depth = 1
        while pos < len(text) and depth > 0:
            c = text[pos]
            if c == "[":
                depth += 1
            elif c == "]":
                depth -= 1
            pos += 1
        if depth != 0:
            pytest.fail(f"Unbalanced `permissions: [...]` brackets in {fw_path}.")
        return text[start:pos]

    def _load_firewall_permissions(self) -> set[str]:
        # Pick permission-level `name: "..."` entries, not the outer
        # firewall name or any future sibling structures.
        return set(re.findall(r'name:\s*"([^"]+)"', self._firewall_block()))

    def _load_firewall_rules(self) -> dict[str, set[tuple[str, str]]]:
        """Return ``{scope: {(method, pattern), ...}}`` from the generated
        firewall.  Used to verify that every classifier path override
        actually exists as a rule under its claimed scope."""
        block = self._firewall_block()
        group_re = re.compile(
            r'name:\s*"(?P<name>[^"]+)"\s*,'
            r'(?:\s*description:\s*"[^"]*"\s*,)?'
            r"\s*rules:\s*\[(?P<rules>.*?)\]",
            re.DOTALL,
        )
        rule_re = re.compile(r'"(?P<method>[A-Z]+)\s+(?P<pattern>[^"]+)"')
        result: dict[str, set[tuple[str, str]]] = {}
        for m in group_re.finditer(block):
            rules = {
                (r.group("method"), r.group("pattern")) for r in rule_re.finditer(m.group("rules"))
            }
            result[m.group("name")] = rules
        return result

    def test_every_firewall_scope_is_mapped_or_intentionally_skipped(self):
        firewall_scopes = self._load_firewall_permissions()
        classified = set(_PERMISSION_TO_BUCKET.keys())
        accounted_for = classified | self._INTENTIONALLY_UNMAPPED
        missing = firewall_scopes - accounted_for
        assert not missing, (
            "The X firewall generator produces permission names that the "
            f"classifier does not handle: {sorted(missing)}.  Either add an "
            f"entry to `_PERMISSION_TO_BUCKET` in x_billing.py or (if the "
            "scope should stay unbilled) add it to "
            "`TestFirewallConsistency._INTENTIONALLY_UNMAPPED`."
        )

    def test_no_classifier_entry_is_stale(self):
        """Guard against typos: every key in `_PERMISSION_TO_BUCKET` must
        correspond to an actual scope the firewall generator emits."""
        firewall_scopes = self._load_firewall_permissions()
        stale = set(_PERMISSION_TO_BUCKET.keys()) - firewall_scopes
        assert not stale, (
            "The classifier has entries for scopes that no longer appear "
            f"in the firewall generator output: {sorted(stale)}.  Either "
            "these scopes were renamed/removed upstream, or the keys are "
            "typos."
        )

    def test_overrides_never_reference_intentionally_unmapped(self):
        """`classify_bucket` consults ``_PATH_OVERRIDES`` before
        ``_PERMISSION_TO_BUCKET``, so an override under an
        intentionally-unmapped scope would silently enable billing for
        a scope we've decided not to bill (e.g. ``app-only``)."""
        override_scopes = {scope for scope, *_ in _PATH_OVERRIDES}
        clashing = override_scopes & self._INTENTIONALLY_UNMAPPED
        assert not clashing, (
            "These scopes are in _INTENTIONALLY_UNMAPPED but also appear "
            f"in _PATH_OVERRIDES: {sorted(clashing)}.  The override would "
            "override the unmapped decision and start emitting usage_event "
            "rows.  Either remove the override or drop the scope from "
            "_INTENTIONALLY_UNMAPPED and add it to _PERMISSION_TO_BUCKET."
        )

    def test_every_override_path_exists_in_firewall(self):
        """Each `_PATH_OVERRIDES` entry must point at a real rule in the
        firewall generator output.  Catches typos in the method or path
        pattern that would otherwise silently fail to match at runtime."""
        firewall = self._load_firewall_rules()
        missing: list[tuple[str, str, str]] = []
        for scope, method, pattern, _bucket in _PATH_OVERRIDES:
            rules = firewall.get(scope, set())
            if (method, pattern) not in rules:
                missing.append((scope, method, pattern))
        assert not missing, (
            "Classifier overrides reference (scope, method, path) tuples "
            f"that are not in the firewall generator output: {missing}.  "
            "Either the firewall rule was renamed/removed upstream, or "
            "the override has a typo."
        )


class TestSeedConsistency:
    """Every bucket the classifier can emit must have a pricing row in
    ``turbo/apps/web/scripts/dev-seed.ts``.  Without that, the billing
    processor would stamp ``billing_error = 'missing_pricing'`` and
    charge $0 for legitimate requests.
    """

    def _load_seed_categories(self) -> set[str]:
        seed_path = (
            pathlib.Path(__file__).resolve().parent.parent.parent.parent.parent
            / "turbo"
            / "apps"
            / "web"
            / "scripts"
            / "dev-seed.ts"
        )
        if not seed_path.exists():
            pytest.fail(
                f"dev-seed.ts not found at {seed_path}.  The X_CONNECTOR_PRICING "
                "block has likely moved — update this test's path computation."
            )
        text = seed_path.read_text()
        # Walk from the X_CONNECTOR_PRICING declaration to its closing
        # bracket so we don't accidentally scoop up other category-like
        # strings elsewhere in the file.
        try:
            start = text.index("const X_CONNECTOR_PRICING")
            end = text.index("];", start)
        except ValueError:
            pytest.fail(
                "Could not locate the `const X_CONNECTOR_PRICING = [...]` block "
                f"in {seed_path}.  Either the variable was renamed or the array "
                "syntax changed — update this test to match."
            )
        block = text[start:end]
        return set(re.findall(r'category:\s*"([^"]+)"', block))

    def _emitted_buckets(self) -> set[str]:
        emitted = set(_PERMISSION_TO_BUCKET.values())
        emitted.update(bucket for _, _, _, bucket in _PATH_OVERRIDES)
        emitted.update(_INCLUDES_TO_BUCKET.values())
        # refine_bucket_with_body may downgrade the with-url bucket —
        # derive the target by invoking it on a no-URL body rather than
        # hardcoding the bucket name.
        downgraded = refine_bucket_with_body(
            "content.create_with_url",
            "POST",
            "/2/tweets",
            json.dumps({"text": "plain text without any link"}).encode(),
        )
        emitted.add(downgraded)
        # Unknown ``includes.<key>`` categories are synthetic per-request
        # strings; they intentionally have no seed row — the billing
        # processor applies a server-side fallback price.  Not included
        # in the check.
        return emitted

    def test_every_emitted_bucket_is_in_seed(self):
        seed = self._load_seed_categories()
        emitted = self._emitted_buckets()
        missing = emitted - seed
        assert not missing, f"classifier emits buckets not present in dev-seed: {sorted(missing)}"

    def test_fallback_row_is_seeded(self):
        """Unknown ``includes.<key>`` categories rely on the
        ``__fallback__`` seed row for server-side pricing.  If that row
        is deleted the billing processor silently charges $0 for any
        unrecognised includes type."""
        seed = self._load_seed_categories()
        assert "__fallback__" in seed, (
            "dev-seed.ts lost the `__fallback__` X_CONNECTOR_PRICING row.  "
            "Unknown includes keys would bill at $0 — restore the row."
        )
