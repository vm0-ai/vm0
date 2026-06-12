"""Direct X connector usage reporting tests."""

import gzip
import json
import zlib
from unittest.mock import patch

import pytest

from body_limits import STREAM_BUFFER_LIMIT
from tests.x_flow_helpers import (
    json_body_that_exceeds_decoder_recursion,
    json_body_that_exceeds_integer_digit_limit,
)


def test_logs_write_operation_charges_one(x_usage, tmp_path, real_flow):
    """POST /2/tweets (no request body parsed) -> stay on the expensive
    with_url bucket, quantity=1."""
    body = json.dumps({"data": {"id": "99", "text": "new tweet"}}).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=body,
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


def test_x_json_parse_error_on_write_does_not_emit_lost_visibility_log(
    x_usage, tmp_path, real_flow
):
    """Write operations bill by method and should not emit read visibility errors."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.metadata["x_json_state"] = {
        "body_parsed": False,
        "body_truncated": False,
        "parse_error": "incomplete json",
    }
    proxy_log = tmp_path / "proxy.jsonl"

    p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1
    assert proxy_log.exists()
    entries = [json.loads(line) for line in proxy_log.read_text().splitlines()]
    assert all(entry["level"] != "error" for entry in entries)
    assert all("unparseable" not in entry["message"].lower() for entry in entries)
    assert all("parse_error" not in entry for entry in entries)


def test_tweet_create_plain_text_downgrades_to_content_create(x_usage, tmp_path, real_flow):
    """POST /2/tweets with text only (no URL, no quote, no media)
    downgrades to the cheaper Content: Create bucket."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = json.dumps({"text": "hello world"}).encode()
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create"
    assert p["quantity"] == 1


@pytest.mark.parametrize(
    ("request_encoding", "request_body"),
    [
        ("gzip", gzip.compress(json.dumps({"text": "hello world"}).encode())),
        ("deflate", zlib.compress(json.dumps({"text": "hello world"}).encode())),
    ],
)
def test_tweet_create_compressed_plain_text_downgrades_to_content_create(
    x_usage, tmp_path, real_flow, request_encoding, request_body
):
    """Small compressed tweet create bodies still refine to Content: Create."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=request_body,
        request_encoding=request_encoding,
    )
    flow.request.method = "POST"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create"
    assert p["quantity"] == 1


def test_tweet_create_gzip_decoded_body_over_cap_stays_conservative(x_usage, tmp_path, real_flow):
    """A gzip body that expands beyond the billing inspection cap is not refined."""
    long_text = "x" * STREAM_BUFFER_LIMIT
    request_body = gzip.compress(json.dumps({"text": long_text}).encode())
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=request_body,
        request_encoding="gzip",
    )
    flow.request.method = "POST"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


def test_tweet_create_raw_body_over_cap_stays_conservative(x_usage, tmp_path, real_flow):
    """An oversized identity request body is not refined."""
    request_body = b"{" + b'"text":"' + b"x" * STREAM_BUFFER_LIMIT + b'"}'
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=request_body,
    )
    flow.request.method = "POST"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


@pytest.mark.parametrize("request_encoding", ["gzip", "br", "zstd", "x-vm0-test"])
def test_tweet_create_invalid_or_unsupported_encoding_stays_conservative(
    x_usage, tmp_path, real_flow, request_encoding
):
    """Invalid compressed or unsupported encoded bodies are not refined."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=b'{"text":"hello world"}',
        request_encoding=request_encoding,
    )
    flow.request.method = "POST"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


def test_non_refinement_flow_does_not_decode_request_body(x_usage, tmp_path, real_flow):
    """Only body-refinement candidates should inspect request content."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/123/retweeted_by?max_results=10",
        body=json.dumps({"data": [{"id": "u1"}]}).encode(),
        permission="tweet.read",
        rule="GET /2/tweets/{id}/retweeted_by",
        request_body=b"not gzip request content",
        request_encoding="gzip",
    )
    flow.metadata["original_url"] = "https://api.x.com/2/tweets/123/retweeted_by?max_results=10"

    with patch(
        "usage.providers.connectors.x.billing_body.decode_request_body_for_billing"
    ) as decode_request_body:
        p = x_usage.call_and_get_single_billing(flow)

    decode_request_body.assert_not_called()
    assert p["category"] == "user.read"
    assert p["quantity"] == 1


@pytest.mark.parametrize(
    "text",
    [
        "check https://example.com",
        "check HTTPS://example.com",
        "check HtTp://www.ExaMPLE.COM/index.html",
        "Visit vm0.ai for details",
        "Visit vm0.ai.",
        "(vm0.ai)",
        "Visit go.dev",
        "Read example.museum",
        "Label:example.com",
        "Param url=example.com",
        "Pipe|example.com",
        "Visit EXAMPLE.COM",
        "Visit 123.com",
        "Visit blog.example.co.uk",
        "Open example.com/path/to/resource?search=foo&lang=en",
        "Open example.com:443/path",
        "Open xn--r8jz45g.xn--q9jyb4c",
        "IDN 例え.みんな",
        "Accent mañana.com",
        "Sharp S faß.de",
        "Fullwidth compatibility \uff26\uff2f\uff2f.com",
    ],
)
def test_tweet_create_with_url_stays_on_with_url_bucket(x_usage, tmp_path, real_flow, text):
    """POST /2/tweets whose text contains a URL stays on the
    Content: Create (with URL) bucket."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = json.dumps({"text": text}).encode()
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


@pytest.mark.parametrize(
    "text",
    [
        "Email support@example.com",
        "Mention @twitter.com",
        "Tag #twitter.com",
        "Cash $twitter.com",
        "Path /twitter.com",
        "Archive long.test.tar.bz2",
        "Word abcHTTPS://example.com",
        "Fullwidth mention \uff20twitter.com",
        "Fullwidth tag \uff03twitter.com",
        "Plus suffix example.com+tag",
        "At suffix example.com@user",
        "Unknown example.notatld",
        "Fullwidth unknown \uff26\uff2f\uff2f.notatld",
        "Underscore foo_bar.example.com",
        "Leading hyphen -bad.com",
        "Trailing hyphen bad-.com",
    ],
)
def test_tweet_create_url_like_non_links_downgrade_to_content_create(
    x_usage, tmp_path, real_flow, text
):
    """twitter-text-style boundary guards avoid obvious non-link
    domains while still allowing plain text to downgrade."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = json.dumps({"text": text}).encode()
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create"
    assert p["quantity"] == 1


def test_tweet_create_rendered_link_signals_stay_on_with_url_bucket(x_usage, tmp_path, real_flow):
    """Quote tweets, attached media, cards, and DM deep links render links;
    we stay on the expensive bucket even when the text has no URL."""
    for req_body in [
        # quote tweet
        json.dumps({"text": "nice", "quote_tweet_id": "abc"}).encode(),
        # attached media
        json.dumps({"text": "pic", "media": {"media_ids": ["42"]}}).encode(),
        # attached card
        json.dumps({"text": "card", "card_uri": "card://123"}).encode(),
        # direct-message deep link
        json.dumps(
            {
                "text": "DM me for details",
                "direct_message_deep_link": "https://x.com/messages/compose?recipient_id=123",
            }
        ).encode(),
    ]:
        flow = x_usage.make_flow(
            real_flow,
            tmp_path,
            path="/2/tweets",
            body=json.dumps({"data": {"id": "1"}}).encode(),
            status=201,
            permission="tweet.write",
            rule="POST /2/tweets",
        )
        flow.request.method = "POST"
        flow.request.content = req_body
        p = x_usage.call_and_get_single_billing(flow)
        assert p["category"] == "content.create_with_url"
        assert p["quantity"] == 1


@pytest.mark.parametrize("direct_message_deep_link", ["", "   ", None, 123, {"url": "x"}])
def test_tweet_create_invalid_direct_message_deep_link_downgrades_to_content_create(
    x_usage, tmp_path, real_flow, direct_message_deep_link
):
    """Invalid DM deep-link values do not block the plain-text downgrade."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = json.dumps(
        {"text": "DM me for details", "direct_message_deep_link": direct_message_deep_link}
    ).encode()
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create"
    assert p["quantity"] == 1


def test_tweet_create_unparseable_body_stays_conservative(x_usage, tmp_path, real_flow):
    """A malformed request body keeps billing on the max bucket so
    we never under-charge on parse failure."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = b"not valid json at all"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"


@pytest.mark.parametrize(
    "request_body",
    [
        pytest.param(json_body_that_exceeds_decoder_recursion(), id="decoder-recursion"),
        pytest.param(json_body_that_exceeds_integer_digit_limit(), id="integer-digit-limit"),
    ],
)
def test_tweet_create_json_parser_failure_stays_conservative(
    x_usage, tmp_path, real_flow, request_body
):
    """Stdlib JSON parser failures must not interrupt tweet-create billing."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = request_body

    p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


def test_delete_method_charges_one(x_usage, tmp_path, real_flow):
    """DELETE /2/tweets/{id} routes to Content: Manage, not the
    tweet.write scope default.  Writes always charge quantity=1
    regardless of response shape."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/123",
        body=b"",
        permission="tweet.write",
        rule="DELETE /2/tweets/{id}",
    )
    flow.request.method = "DELETE"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.manage"
    assert p["quantity"] == 1
