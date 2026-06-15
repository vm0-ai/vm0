"""AWS-aware firewall rule matching through the production compiled matcher."""

import matching
from tests.firewall_helpers import (
    firewall_api,
    firewall_entry,
    firewall_permission,
    match_compiled_firewalls,
    network_policy,
)

AWS_AUTH = {
    "awsSigv4": {
        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
        "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
    }
}
AWS_BASE = "https://{awsHost+}.amazonaws.com"


def _aws_firewall(*permissions):
    return [
        firewall_entry(
            "aws",
            firewall_api(AWS_BASE, permissions, auth=AWS_AUTH),
        )
    ]


def _sigv4_context(service, *, headers=(), body=None):
    return matching.FirewallRequestContext(
        headers=(
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                f"Credential=ASIAC0FFEE5AFE10CA1C/20240101/us-east-1/{service}/aws4_request, "
                "SignedHeaders=host;x-amz-date, Signature=deadbeef",
            ),
            ("x-amz-date", "20240101T000000Z"),
            ("host", f"{service}.us-east-1.amazonaws.com"),
            *headers,
        ),
        body=body,
    )


def test_ec2_query_action_from_url_distinguishes_permissions():
    firewalls = _aws_firewall(
        firewall_permission(
            "ec2:DescribeInstances",
            "POST / AWS sigv4=ec2 action=DescribeInstances",
        ),
        firewall_permission(
            "ec2:RunInstances",
            "POST / AWS sigv4=ec2 action=RunInstances",
        ),
    )
    policies = {"aws": network_policy(deny=["ec2:RunInstances"], unknown_policy="deny")}

    describe = match_compiled_firewalls(
        "https://ec2.us-east-1.amazonaws.com/?Action=DescribeInstances&Version=2016-11-15",
        firewalls,
        policies,
        method="POST",
        request_context=_sigv4_context("ec2"),
    )
    assert isinstance(describe, matching.FirewallAllow)
    assert describe.permission == "ec2:DescribeInstances"
    assert describe.rule == "POST / AWS sigv4=ec2 action=DescribeInstances"

    run = match_compiled_firewalls(
        "https://ec2.us-east-1.amazonaws.com/?Action=RunInstances&Version=2016-11-15",
        firewalls,
        policies,
        method="POST",
        request_context=_sigv4_context("ec2"),
    )
    assert isinstance(run, matching.FirewallBlock)
    assert run.reason == "permission_denied"
    assert run.permissions == ("ec2:RunInstances",)


def test_ec2_query_action_from_form_body_matches():
    firewalls = _aws_firewall(
        firewall_permission(
            "ec2:DescribeInstances",
            "POST / AWS sigv4=ec2 action=DescribeInstances",
        )
    )
    result = match_compiled_firewalls(
        "https://ec2.us-east-1.amazonaws.com/",
        firewalls,
        {"aws": network_policy(unknown_policy="deny")},
        method="POST",
        request_context=_sigv4_context(
            "ec2",
            headers=(("content-type", "application/x-www-form-urlencoded; charset=utf-8"),),
            body=b"Action=DescribeInstances&Version=2016-11-15",
        ),
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "ec2:DescribeInstances"


def test_ec2_missing_or_duplicate_action_uses_unknown_policy():
    firewalls = _aws_firewall(
        firewall_permission(
            "ec2:DescribeInstances",
            "POST / AWS sigv4=ec2 action=DescribeInstances",
        )
    )
    policies = {"aws": network_policy(unknown_policy="deny")}

    missing = match_compiled_firewalls(
        "https://ec2.us-east-1.amazonaws.com/?Version=2016-11-15",
        firewalls,
        policies,
        method="POST",
        request_context=_sigv4_context("ec2"),
    )
    assert isinstance(missing, matching.FirewallBlock)
    assert missing.reason == "unknown_endpoint"

    duplicate = match_compiled_firewalls(
        "https://ec2.us-east-1.amazonaws.com/?Action=DescribeInstances&Action=RunInstances",
        firewalls,
        policies,
        method="POST",
        request_context=_sigv4_context("ec2"),
    )
    assert isinstance(duplicate, matching.FirewallBlock)
    assert duplicate.reason == "unknown_endpoint"

    duplicate_with_body_fallback = match_compiled_firewalls(
        "https://ec2.us-east-1.amazonaws.com/?Action=DescribeInstances&Action=RunInstances",
        firewalls,
        policies,
        method="POST",
        request_context=_sigv4_context(
            "ec2",
            headers=(("content-type", "application/x-www-form-urlencoded"),),
            body=b"Action=DescribeInstances",
        ),
    )
    assert isinstance(duplicate_with_body_fallback, matching.FirewallBlock)
    assert duplicate_with_body_fallback.reason == "unknown_endpoint"


def test_dynamodb_json_target_distinguishes_permissions():
    firewalls = _aws_firewall(
        firewall_permission(
            "dynamodb:GetItem",
            "POST / AWS sigv4=dynamodb target=DynamoDB_20120810.GetItem",
        ),
        firewall_permission(
            "dynamodb:PutItem",
            "POST / AWS sigv4=dynamodb target=DynamoDB_20120810.PutItem",
        ),
    )
    policies = {"aws": network_policy(deny=["dynamodb:PutItem"], unknown_policy="deny")}

    get_item = match_compiled_firewalls(
        "https://dynamodb.us-east-1.amazonaws.com/",
        firewalls,
        policies,
        method="POST",
        request_context=_sigv4_context(
            "dynamodb",
            headers=(("x-amz-target", "DynamoDB_20120810.GetItem"),),
        ),
    )
    assert isinstance(get_item, matching.FirewallAllow)
    assert get_item.permission == "dynamodb:GetItem"

    put_item = match_compiled_firewalls(
        "https://dynamodb.us-east-1.amazonaws.com/",
        firewalls,
        policies,
        method="POST",
        request_context=_sigv4_context(
            "dynamodb",
            headers=(("x-amz-target", "DynamoDB_20120810.PutItem"),),
        ),
    )
    assert isinstance(put_item, matching.FirewallBlock)
    assert put_item.permissions == ("dynamodb:PutItem",)


def test_s3_rest_subresource_distinguishes_permissions():
    firewalls = _aws_firewall(
        firewall_permission(
            "s3:GetObject",
            "GET /{Bucket}/{Key+} AWS sigv4=s3",
        ),
        firewall_permission(
            "s3:GetObjectTagging",
            "GET /{Bucket}/{Key+}?tagging AWS sigv4=s3",
        ),
    )
    policies = {"aws": network_policy(unknown_policy="deny")}

    get_object = match_compiled_firewalls(
        "https://s3.amazonaws.com/my-bucket/my-key",
        firewalls,
        policies,
        method="GET",
        request_context=_sigv4_context("s3"),
    )
    assert isinstance(get_object, matching.FirewallAllow)
    assert get_object.permission == "s3:GetObject"
    assert get_object.params == {"awsHost": "s3", "Bucket": "my-bucket", "Key": "my-key"}

    get_tagging = match_compiled_firewalls(
        "https://s3.amazonaws.com/my-bucket/my-key?tagging",
        firewalls,
        policies,
        method="GET",
        request_context=_sigv4_context("s3"),
    )
    assert isinstance(get_tagging, matching.FirewallAllow)
    assert get_tagging.permission == "s3:GetObjectTagging"
    assert get_tagging.rule == "GET /{Bucket}/{Key+}?tagging AWS sigv4=s3"


def test_s3_unknown_subresource_uses_unknown_policy():
    firewalls = _aws_firewall(
        firewall_permission(
            "s3:GetObject",
            "GET /{Bucket}/{Key+} AWS sigv4=s3",
        )
    )
    result = match_compiled_firewalls(
        "https://s3.amazonaws.com/my-bucket/my-key?versionId=1",
        firewalls,
        {"aws": network_policy(unknown_policy="deny")},
        method="GET",
        request_context=_sigv4_context("s3"),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "unknown_endpoint"


def test_aws_predicate_rule_requires_matching_sigv4_service():
    firewalls = _aws_firewall(
        firewall_permission(
            "ec2:DescribeInstances",
            "POST / AWS sigv4=ec2 action=DescribeInstances",
        )
    )
    result = match_compiled_firewalls(
        "https://ec2.us-east-1.amazonaws.com/?Action=DescribeInstances",
        firewalls,
        {"aws": network_policy(unknown_policy="deny")},
        method="POST",
        request_context=_sigv4_context("s3"),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "unknown_endpoint"
