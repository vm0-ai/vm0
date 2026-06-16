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
                "Credential="
                "ASIAC0FFEE5AFE10CA1C"
                f"/20240101/us-east-1/{service}/aws4_request, "
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


def test_s3_virtual_hosted_style_rest_rules_use_bucket_from_host():
    firewalls = [
        firewall_entry(
            "aws",
            firewall_api(
                AWS_BASE,
                [
                    firewall_permission(
                        "s3:GetObject",
                        "GET /{Bucket}/{Key+} AWS sigv4=s3",
                    ),
                ],
                auth=AWS_AUTH,
            ),
            firewall_api(
                "https://{Bucket+}.s3.{Region}.amazonaws.com",
                [
                    firewall_permission(
                        "s3:GetObject",
                        "GET /{Key+} AWS sigv4=s3",
                    ),
                    firewall_permission(
                        "s3:GetObjectTagging",
                        "GET /{Key+}?tagging AWS sigv4=s3",
                    ),
                    firewall_permission(
                        "s3:PutBucketAcl",
                        "PUT /?acl AWS sigv4=s3",
                    ),
                ],
                auth=AWS_AUTH,
            ),
        )
    ]
    policies = {"aws": network_policy(deny=["s3:PutBucketAcl"], unknown_policy="deny")}

    get_object = match_compiled_firewalls(
        "https://my-bucket.s3.us-east-1.amazonaws.com/path/to/key",
        firewalls,
        policies,
        method="GET",
        request_context=_sigv4_context("s3"),
    )
    assert isinstance(get_object, matching.FirewallAllow)
    assert get_object.permission == "s3:GetObject"
    assert get_object.rule == "GET /{Key+} AWS sigv4=s3"
    assert get_object.params == {
        "Bucket": "my-bucket",
        "Region": "us-east-1",
        "Key": "path/to/key",
    }

    get_tagging = match_compiled_firewalls(
        "https://my-bucket.s3.us-east-1.amazonaws.com/path/to/key?tagging",
        firewalls,
        policies,
        method="GET",
        request_context=_sigv4_context("s3"),
    )
    assert isinstance(get_tagging, matching.FirewallAllow)
    assert get_tagging.permission == "s3:GetObjectTagging"

    put_bucket_acl = match_compiled_firewalls(
        "https://my-bucket.s3.us-east-1.amazonaws.com/?acl",
        firewalls,
        policies,
        method="PUT",
        request_context=_sigv4_context("s3"),
    )
    assert isinstance(put_bucket_acl, matching.FirewallBlock)
    assert put_bucket_acl.reason == "permission_denied"
    assert put_bucket_acl.permissions == ("s3:PutBucketAcl",)


def test_s3_rest_operation_query_parameters_match_base_operation():
    firewalls = _aws_firewall(
        firewall_permission(
            "s3:GetObject",
            "GET /{Bucket}/{Key+} AWS sigv4=s3",
        )
    )
    part_number = match_compiled_firewalls(
        "https://s3.amazonaws.com/my-bucket/my-key?partNumber=1",
        firewalls,
        {"aws": network_policy(unknown_policy="deny")},
        method="GET",
        request_context=_sigv4_context("s3"),
    )
    assert isinstance(part_number, matching.FirewallAllow)
    assert part_number.permission == "s3:GetObject"

    response_override = match_compiled_firewalls(
        "https://s3.amazonaws.com/my-bucket/my-key?response-content-type=text%2Fplain",
        firewalls,
        {"aws": network_policy(unknown_policy="deny")},
        method="GET",
        request_context=_sigv4_context("s3"),
    )
    assert isinstance(response_override, matching.FirewallAllow)
    assert response_override.permission == "s3:GetObject"


def test_s3_version_id_uses_unknown_policy():
    firewalls = _aws_firewall(
        firewall_permission(
            "s3:GetObject",
            "GET /{Bucket}/{Key+} AWS sigv4=s3",
        ),
        firewall_permission(
            "s3:DeleteObject",
            "DELETE /{Bucket}/{Key+} AWS sigv4=s3",
        ),
        firewall_permission(
            "s3:GetObjectTagging",
            "GET /{Bucket}/{Key+}?tagging AWS sigv4=s3",
        ),
    )
    policies = {"aws": network_policy(unknown_policy="deny")}

    get_version = match_compiled_firewalls(
        "https://s3.amazonaws.com/my-bucket/my-key?versionId=1",
        firewalls,
        policies,
        method="GET",
        request_context=_sigv4_context("s3"),
    )
    assert isinstance(get_version, matching.FirewallBlock)
    assert get_version.reason == "unknown_endpoint"

    delete_version = match_compiled_firewalls(
        "https://s3.amazonaws.com/my-bucket/my-key?versionId=1",
        firewalls,
        policies,
        method="DELETE",
        request_context=_sigv4_context("s3"),
    )
    assert isinstance(delete_version, matching.FirewallBlock)
    assert delete_version.reason == "unknown_endpoint"

    get_version_tagging = match_compiled_firewalls(
        "https://s3.amazonaws.com/my-bucket/my-key?tagging&versionId=1",
        firewalls,
        policies,
        method="GET",
        request_context=_sigv4_context("s3"),
    )
    assert isinstance(get_version_tagging, matching.FirewallBlock)
    assert get_version_tagging.reason == "unknown_endpoint"


def test_s3_copy_source_header_uses_unknown_policy():
    firewalls = _aws_firewall(
        firewall_permission(
            "s3:PutObject",
            "PUT /{Bucket}/{Key+} AWS sigv4=s3",
        )
    )
    policies = {"aws": network_policy(unknown_policy="deny")}

    put_object = match_compiled_firewalls(
        "https://s3.amazonaws.com/destination-bucket/copied-key",
        firewalls,
        policies,
        method="PUT",
        request_context=_sigv4_context("s3"),
    )
    assert isinstance(put_object, matching.FirewallAllow)
    assert put_object.permission == "s3:PutObject"

    copy_object = match_compiled_firewalls(
        "https://s3.amazonaws.com/destination-bucket/copied-key",
        firewalls,
        policies,
        method="PUT",
        request_context=_sigv4_context(
            "s3",
            headers=(("x-amz-copy-source", "source-bucket/source-key"),),
        ),
    )
    assert isinstance(copy_object, matching.FirewallBlock)
    assert copy_object.reason == "unknown_endpoint"


def test_s3_unknown_subresource_uses_unknown_policy():
    firewalls = _aws_firewall(
        firewall_permission(
            "s3:GetObject",
            "GET /{Bucket}/{Key+} AWS sigv4=s3",
        )
    )
    result = match_compiled_firewalls(
        "https://s3.amazonaws.com/my-bucket/my-key?acl",
        firewalls,
        {"aws": network_policy(unknown_policy="deny")},
        method="GET",
        request_context=_sigv4_context("s3"),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "unknown_endpoint"


def test_s3_subresource_rejects_ambiguous_extra_subresource():
    firewalls = _aws_firewall(
        firewall_permission(
            "s3:GetObjectTagging",
            "GET /{Bucket}/{Key+}?tagging AWS sigv4=s3",
        )
    )
    result = match_compiled_firewalls(
        "https://s3.amazonaws.com/my-bucket/my-key?tagging&acl",
        firewalls,
        {"aws": network_policy(unknown_policy="deny")},
        method="GET",
        request_context=_sigv4_context("s3"),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "unknown_endpoint"


def test_rest_query_value_distinguishes_permissions():
    firewalls = _aws_firewall(
        firewall_permission(
            "apigateway:ImportApiKeys",
            "POST /apikeys?mode=import AWS sigv4=apigateway",
        )
    )
    policies = {"aws": network_policy(unknown_policy="deny")}

    import_api_keys = match_compiled_firewalls(
        "https://apigateway.us-east-1.amazonaws.com/apikeys?mode=import",
        firewalls,
        policies,
        method="POST",
        request_context=_sigv4_context("apigateway"),
    )
    assert isinstance(import_api_keys, matching.FirewallAllow)
    assert import_api_keys.permission == "apigateway:ImportApiKeys"

    wrong_mode = match_compiled_firewalls(
        "https://apigateway.us-east-1.amazonaws.com/apikeys?mode=export",
        firewalls,
        policies,
        method="POST",
        request_context=_sigv4_context("apigateway"),
    )
    assert isinstance(wrong_mode, matching.FirewallBlock)
    assert wrong_mode.reason == "unknown_endpoint"

    extra_operation_query = match_compiled_firewalls(
        "https://apigateway.us-east-1.amazonaws.com/apikeys?mode=import&operation=delete",
        firewalls,
        policies,
        method="POST",
        request_context=_sigv4_context("apigateway"),
    )
    assert isinstance(extra_operation_query, matching.FirewallBlock)
    assert extra_operation_query.reason == "unknown_endpoint"


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
