"""Tests for URL reconstruction and rewrite utilities."""

import url_utils


class TestBuildRewriteUrl:
    """Tests for build_rewrite_url pure URL construction."""

    def test_simple_base_no_rel_path(self):
        url = url_utils.build_rewrite_url(
            "https://discord.com/api/webhooks/123/abc",
            "/",
            "",
        )
        assert url == "https://discord.com/api/webhooks/123/abc"

    def test_multi_segment_rel_path(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/base",
            "/a/b/c",
            "",
        )
        assert url == "https://example.com/base/a/b/c"

    def test_base_with_query_no_orig_query(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "",
        )
        assert url == "https://example.com/hook?token=secret"

    def test_empty_orig_query_ignored(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook",
            "/",
            "",
        )
        assert url == "https://example.com/hook"

    def test_rel_path_with_both_queries_merged(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=abc",
            "/sub",
            "extra=1",
        )
        assert url == "https://example.com/hook/sub?token=abc&extra=1"

    def test_original_duplicate_query_key_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_duplicate_query_key_followed_by_empty_segment_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "token=attacker&&wait=true",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_duplicate_query_key_preceded_by_empty_segment_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "wait=true&&token=attacker",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_all_original_duplicate_query_keys_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "token=first&token=second",
        )
        assert url == "https://example.com/hook?token=secret"

    def test_original_encoded_duplicate_query_key_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "to%6ben=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_duplicate_of_encoded_trusted_base_query_key_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?to%6ben=secret",
            "/",
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?to%6ben=secret&wait=true"

    def test_original_plus_encoded_duplicate_query_key_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api+key=secret",
            "/",
            "api%20key=attacker&wait=true",
        )
        assert url == "https://example.com/hook?api+key=secret&wait=true"

    def test_original_semicolon_duplicate_query_key_dropped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "wait=true;token=attacker",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_semicolon_duplicate_before_kept_pair_uses_source_separator(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "token=attacker;wait=true",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_semicolon_duplicate_between_kept_pairs_uses_safe_separator(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "keep=1;token=attacker;wait=true",
        )
        assert url == "https://example.com/hook?token=secret&keep=1&wait=true"

    def test_duplicate_trusted_base_query_keys_preserved(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=first&token=second",
            "/",
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=first&token=second&wait=true"

    def test_duplicate_trusted_base_query_keys_with_semicolon_preserved(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=first;token=second",
            "/",
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=first;token=second&wait=true"

    def test_blank_trusted_base_query_value_is_authoritative(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=",
            "/",
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=&wait=true"

    def test_valueless_trusted_base_query_key_is_authoritative(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token",
            "/",
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token&wait=true"

    def test_empty_trusted_base_query_key_is_authoritative(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?=secret",
            "/",
            "=attacker&wait=true",
        )
        assert url == "https://example.com/hook?=secret&wait=true"

    def test_empty_trusted_base_query_segments_do_not_block_empty_original_key(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?&&region=us",
            "/",
            "=agent&q=test",
        )
        assert url == "https://example.com/hook?&&region=us&=agent&q=test"

    def test_auth_query_overrides_base_and_original_query(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api_key=base&region=us",
            "/",
            "api_key=agent&q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_empty_key_overrides_base_and_original_empty_keys(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?=base&region=us",
            "/",
            "=agent&q=test",
            {"": "trusted"},
        )
        assert url == "https://example.com/hook?region=us&q=test&=trusted"

    def test_auth_query_overrides_base_query_without_leading_empty_segment(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api_key=base&&region=us",
            "/",
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_base_query_without_trailing_empty_segment(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?region=us&&api_key=base",
            "/",
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_all_lower_priority_duplicates(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api_key=base",
            "/",
            "api_key=agent",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?api_key=trusted+key"

    def test_auth_query_overrides_duplicate_trusted_base_query_keys(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api_key=first&api_key=second&region=us",
            "/",
            "api_key=agent&q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_encoded_base_and_original_query_keys(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api%5Fkey=base&region=us",
            "/",
            "api%5fkey=agent&q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_plus_encoded_lower_priority_keys(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api+key=base&region=us",
            "/",
            "api%20key=agent&q=test",
            {"api key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api+key=trusted+key"

    def test_auth_query_overrides_semicolon_base_without_prefixing_kept_pair(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?api_key=base;region=us",
            "/",
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_semicolon_base_between_kept_pairs(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?tenant=one;api_key=base;region=us",
            "/",
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?tenant=one&region=us&q=test&api_key=trusted+key"

    def test_auth_query_filter_preserves_existing_semicolon_value(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?redirect=a;b&api_key=base&region=us",
            "/",
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?redirect=a;b&region=us&q=test&api_key=trusted+key"

    def test_base_path_params_are_preserved(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook;v=1?token=abc",
            "/sub;mode=fast",
            "extra=1",
        )
        assert url == "https://example.com/hook;v=1/sub;mode=fast?token=abc&extra=1"

    def test_trailing_slash_on_base_deduped(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook/",
            "/sub",
            "",
        )
        assert url == "https://example.com/hook/sub"

    def test_root_rel_path_keeps_base_path(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook",
            "/",
            "",
        )
        assert url == "https://example.com/hook"
