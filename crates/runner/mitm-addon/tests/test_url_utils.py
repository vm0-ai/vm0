"""Tests for URL reconstruction and rewrite utilities."""

import pytest

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

    def test_base_treats_single_terminal_slash_as_optional(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/base/",
            "/a",
            "",
        )
        assert url == "https://example.com/base/a"

    def test_base_preserves_repeated_terminal_empty_segments(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/base//",
            "/a",
            "",
        )
        assert url == "https://example.com/base//a"

    def test_root_base_preserves_repeated_terminal_empty_segments(self):
        url = url_utils.build_rewrite_url(
            "https://example.com//",
            "/a",
            "",
        )
        assert url == "https://example.com//a"

    def test_base_with_query_no_orig_query(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "",
        )
        assert url == "https://example.com/hook?token=secret"

    def test_base_unicode_host_normalized_for_forwarding(self):
        url = url_utils.build_rewrite_url(
            "https://bücher.example:8443/hook",
            "/sub",
            "",
        )
        assert url == "https://xn--bcher-kva.example:8443/hook/sub"

    def test_base_percent_encoded_host_normalized_for_forwarding(self):
        url = url_utils.build_rewrite_url(
            "https://b%C3%BCcher.example/hook",
            "/sub",
            "",
        )
        assert url == "https://xn--bcher-kva.example/hook/sub"

    def test_base_unicode_path_and_query_are_encoded_for_forwarding(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook/路径?token=é",
            "/子",
            "from=请求",
        )
        assert (
            url == "https://example.com/hook/%E8%B7%AF%E5%BE%84/%E5%AD%90"
            "?token=%C3%A9&from=%E8%AF%B7%E6%B1%82"
        )

    def test_existing_percent_encoded_path_and_query_are_not_double_encoded(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook/%E8%B7%AF%E5%BE%84?token=%C3%A9",
            "/%E5%AD%90",
            "from=%E8%AF%B7%E6%B1%82",
        )
        assert (
            url == "https://example.com/hook/%E8%B7%AF%E5%BE%84/%E5%AD%90"
            "?token=%C3%A9&from=%E8%AF%B7%E6%B1%82"
        )

    @pytest.mark.parametrize(
        ("base", "message"),
        [
            ("https://example.com/hook#secret-fragment", "fragment"),
            ("https://example.com/hook\n", "whitespace"),
            ("https://example.com\\hook", "backslash"),
            ("https://example.com/\x00hook", "control characters or invalid Unicode"),
            ("https://example.com/\x7fhook", "control characters or invalid Unicode"),
            ("https://example.com/\ud800hook", "control characters or invalid Unicode"),
            ("ftp://example.com/hook", "scheme"),
            ("https:///hook", "missing host"),
            ("https://user:pass@example.com/hook", "userinfo"),
            ("https://exa mple.com/hook", "whitespace"),
            ("https://example.com:99999/hook", "Port out of range"),
            ("https://[::1/hook", "Invalid IPv6 URL"),
            ("https://example%2ecom/hook", "unsafe percent encoding"),
            ("https://example%2ccom/hook", "unsafe percent encoding"),
            ("https://example%3a443.com/hook", "invalid host"),
            ("https://%7bparam%7d.example/hook", "unsafe percent encoding"),
            ("https://example%zz.com/hook", "invalid percent encoding"),
            ("https://0177.0.0.1/hook", "invalid host"),
            ("https://0177.0.0.1?token=static", "invalid host"),
            ("https://0x7f.0.0.1/hook", "invalid host"),
            ("https://2130706433/hook", "invalid host"),
            ("https://127.1/hook", "invalid host"),
            ("https://127。0。0。1/hook", "invalid host"),
            ("https://127。0。0。1?token=static", "invalid host"),
            ("https://127.0.0.1。/hook", "invalid host"),
            ("https://\uff11\uff12\uff17.\uff10.\uff10.\uff11/hook", "invalid host"),
        ],
    )
    def test_invalid_resolved_base_rejected(self, base, message):
        with pytest.raises(ValueError, match=message):
            url_utils.build_rewrite_url(
                base,
                "/",
                "",
            )

    def test_empty_orig_query_ignored(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook",
            "/",
            "",
        )
        assert url == "https://example.com/hook"

    def test_base_query_allows_raw_at_sign(self):
        url = url_utils.build_rewrite_url(
            "https://example.com/hook?token=a@b",
            "/",
            "",
        )
        assert url == "https://example.com/hook?token=a@b"

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

    @pytest.mark.parametrize(
        "rel_path",
        [
            "/./admin",
            "/../admin",
            "/%2e/admin",
            "/%2e%2e/admin",
            "/%2e%2e%2fadmin",
        ],
    )
    def test_unsafe_rel_path_is_rejected(self, rel_path):
        with pytest.raises(ValueError, match="Unsafe rewrite path"):
            url_utils.build_rewrite_url(
                "https://example.com/hook",
                rel_path,
                "",
            )
