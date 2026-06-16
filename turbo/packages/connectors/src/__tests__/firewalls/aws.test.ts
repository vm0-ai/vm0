import { describe, expect, it } from "vitest";

import {
  extractSecretNamesFromApis,
  type FirewallApi,
} from "../../firewall-types";
import {
  findMatchingPermissions,
  matchFirewallBaseUrl,
} from "../../firewall-rule-matcher";
import {
  getConnectorFirewall,
  getDefaultFirewallPolicies,
  getPermissionCategories,
  isFirewallConnectorType,
} from "../../firewalls/index";
import { awsGenerationStats } from "../../firewalls/aws.generated";

const FORBIDDEN_PLACEHOLDER_WORD_RE = /placeholder|fake|dummy|test|example/i;
type FirewallPermission = NonNullable<FirewallApi["permissions"]>[number];

function matchesAwsFirewall(url: string): boolean {
  const firewall = getConnectorFirewall("aws");
  return firewall.apis.some((api) => {
    return matchFirewallBaseUrl(url, api.base) !== null;
  });
}

function expectRecognizablePlaceholder(value: string | undefined): void {
  expect(value).toBeDefined();
  expect(value).not.toMatch(FORBIDDEN_PLACEHOLDER_WORD_RE);
}

function permissionNames(
  permissions: readonly FirewallPermission[] | undefined,
): string[] {
  return (permissions ?? []).map((permission) => {
    return permission.name;
  });
}

function rulesFor(
  permissions: readonly FirewallPermission[],
  name: string,
): string[] {
  const permission = permissions.find((candidate) => {
    return candidate.name === name;
  });
  if (!permission) {
    throw new Error(`Missing AWS firewall permission ${name}`);
  }
  return permission.rules;
}

function countRules(permissions: readonly FirewallPermission[]): number {
  return permissions.reduce((count, permission) => {
    return count + permission.rules.length;
  }, 0);
}

describe("aws firewall", () => {
  it("registers AWS as a SigV4 firewall connector", () => {
    expect(isFirewallConnectorType("aws")).toBe(true);
    const firewall = getConnectorFirewall("aws");

    expect(firewall.name).toBe("aws");
    expect(
      firewall.apis.map((api) => {
        return api.base;
      }),
    ).toStrictEqual([
      "https://{awsHost+}.amazonaws.com",
      "https://{awsHost+}.amazonaws.com.cn",
      "https://{awsHost+}.api.aws",
      "https://{Bucket+}.s3.amazonaws.com",
      "https://{Bucket+}.s3.{Region}.amazonaws.com",
      "https://{Bucket+}.s3.dualstack.{Region}.amazonaws.com",
      "https://{Bucket+}.s3-fips.{Region}.amazonaws.com",
      "https://{Bucket+}.s3.{Region}.amazonaws.com.cn",
      "https://{Bucket+}.s3.dualstack.{Region}.amazonaws.com.cn",
      "https://{Bucket+}.s3-fips.{Region}.amazonaws.com.cn",
      "https://{Bucket+}.s3-accelerate.amazonaws.com",
      "https://{Bucket+}.s3-accelerate.dualstack.amazonaws.com",
    ]);
    for (const api of firewall.apis) {
      expect(api.auth).toStrictEqual({
        awsSigv4: {
          accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",
          secretAccessKey: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
          sessionToken: "${{ secrets.AWS_SESSION_TOKEN }}",
        },
      });
    }

    expect(extractSecretNamesFromApis([...firewall.apis])).toStrictEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]);
    expect(firewall.placeholders?.AWS_ACCESS_KEY_ID).toMatch(
      /^ASIA[A-Z0-9]{16}$/,
    );
    expect(firewall.placeholders?.AWS_SECRET_ACCESS_KEY).toMatch(
      /^[A-Za-z0-9/+=]{40}$/,
    );
    expect(firewall.placeholders?.AWS_SESSION_TOKEN).toMatch(
      /^[A-Za-z0-9/+=]{20,}$/,
    );
    expectRecognizablePlaceholder(firewall.placeholders?.AWS_ACCESS_KEY_ID);
    expectRecognizablePlaceholder(firewall.placeholders?.AWS_SECRET_ACCESS_KEY);
    expectRecognizablePlaceholder(firewall.placeholders?.AWS_SESSION_TOKEN);
  });

  it("includes generated AWS permissions on standard and S3 virtual hosted APIs", () => {
    const firewall = getConnectorFirewall("aws");
    const standardApis = firewall.apis.slice(0, 3);
    for (const api of standardApis) {
      expect(api.permissions?.length ?? 0).toBeGreaterThan(1000);
      expect(permissionNames(api.permissions)).toEqual(
        expect.arrayContaining([
          "apigateway:POST",
          "ec2:DescribeInstances",
          "ec2:RunInstances",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "iam:CreateRole",
          "lambda:CreateFunction",
          "s3:GetObject",
          "s3:GetObjectTagging",
          "s3:PutBucketAcl",
          "sts:GetCallerIdentity",
        ]),
      );
    }

    const virtualHostedApis = firewall.apis.slice(3);
    for (const api of virtualHostedApis) {
      expect(api.permissions?.length ?? 0).toBeGreaterThan(20);
      expect(permissionNames(api.permissions)).toEqual(
        expect.arrayContaining([
          "s3:GetBucketAcl",
          "s3:GetObject",
          "s3:GetObjectTagging",
          "s3:PutBucketAcl",
          "s3:PutObject",
          "s3:PutObjectTagging",
        ]),
      );
    }
  });

  it("maps representative AWS operations to their IAM permissions", () => {
    const firewall = getConnectorFirewall("aws");
    const permissions = firewall.apis[0]!.permissions ?? [];

    expect(rulesFor(permissions, "ec2:DescribeInstances")).toStrictEqual([
      "GET / AWS sigv4=ec2 action=DescribeInstances",
      "POST / AWS sigv4=ec2 action=DescribeInstances",
    ]);
    expect(rulesFor(permissions, "dynamodb:GetItem")).toContain(
      "POST / AWS sigv4=dynamodb target=DynamoDB_20120810.GetItem",
    );
    expect(rulesFor(permissions, "iam:CreateRole")).toContain(
      "POST / AWS sigv4=iam action=CreateRole",
    );
    expect(rulesFor(permissions, "sts:GetCallerIdentity")).toContain(
      "POST / AWS sigv4=sts action=GetCallerIdentity",
    );
    expect(rulesFor(permissions, "es:CreateDomain")).toContain(
      "POST /2021-01-01/opensearch/domain AWS sigv4=es",
    );
    expect(rulesFor(permissions, "es:AcceptInboundConnection")).toContain(
      "PUT /2021-01-01/opensearch/cc/inboundConnection/{ConnectionId}/accept AWS sigv4=es",
    );
    expect(rulesFor(permissions, "kafka-cluster:CreateTopic")).toContain(
      "POST /v1/clusters/{clusterArn}/topics AWS sigv4=kafka",
    );
    expect(rulesFor(permissions, "iot:StartCommandExecution")).toContain(
      "POST /command-executions AWS sigv4=iot-jobs-data",
    );
    expect(rulesFor(permissions, "apigateway:POST")).toContain(
      "POST /apikeys?mode=import AWS sigv4=apigateway",
    );
    expect(rulesFor(permissions, "apigateway:POST")).not.toContain(
      "POST /apikeys AWS sigv4=apigateway",
    );
    expect(rulesFor(permissions, "apigateway:PATCH")).not.toContain(
      "PATCH /restapis/{restapi_id} AWS sigv4=apigateway",
    );
  });

  it("maps S3 operation selectors to the right IAM permissions", () => {
    const firewall = getConnectorFirewall("aws");
    const standardPermissions = firewall.apis[0]!.permissions ?? [];

    expect(rulesFor(standardPermissions, "s3:GetObjectTagging")).toContain(
      "GET /{Bucket}/{Key+}?tagging AWS sigv4=s3",
    );
    expect(
      rulesFor(standardPermissions, "s3:GetLifecycleConfiguration"),
    ).toContain("GET /{Bucket}?lifecycle AWS sigv4=s3");
    expect(
      rulesFor(standardPermissions, "s3:PutLifecycleConfiguration"),
    ).toContain("PUT /{Bucket}?lifecycle AWS sigv4=s3");
    expect(rulesFor(standardPermissions, "s3:DeleteObject")).not.toContain(
      "POST /{Bucket}?delete AWS sigv4=s3",
    );
    expect(rulesFor(standardPermissions, "s3:GetObject")).not.toContain(
      "PUT /{Bucket}/{Key+} AWS sigv4=s3",
    );
    expect(rulesFor(standardPermissions, "s3:GetObjectAcl")).not.toContain(
      "GET /{Bucket} AWS sigv4=s3",
    );
    expect(rulesFor(standardPermissions, "s3:GetObjectAcl")).not.toContain(
      "GET /{Bucket}?list-type=2 AWS sigv4=s3",
    );
    expect(rulesFor(standardPermissions, "s3:ListBucket")).toEqual(
      expect.arrayContaining([
        "GET /{Bucket} AWS sigv4=s3",
        "GET /{Bucket}?list-type=2 AWS sigv4=s3",
      ]),
    );
    expect(rulesFor(standardPermissions, "s3:PutObject")).toContain(
      "PUT /{Bucket}/{Key+} AWS sigv4=s3",
    );

    const virtualHostedPermissions = firewall.apis[3]!.permissions ?? [];
    expect(rulesFor(virtualHostedPermissions, "s3:DeleteObject")).not.toContain(
      "POST /?delete AWS sigv4=s3",
    );
    expect(rulesFor(virtualHostedPermissions, "s3:GetBucketAcl")).toContain(
      "GET /?acl AWS sigv4=s3",
    );
    expect(rulesFor(virtualHostedPermissions, "s3:GetObject")).toContain(
      "GET /{Key+} AWS sigv4=s3",
    );
    expect(rulesFor(virtualHostedPermissions, "s3:GetObjectTagging")).toContain(
      "GET /{Key+}?tagging AWS sigv4=s3",
    );
  });

  it("registers AWS default policies and permission categories", () => {
    const defaults = getDefaultFirewallPolicies("aws");
    expect(defaults.unknownPolicy).toBe("deny");
    expect(defaults.policies["ec2:DescribeInstances"]).toBe("allow");
    expect(defaults.policies["ec2:RunInstances"]).toBe("deny");
    expect(defaults.policies["ec2:CreateTags"]).toBe("deny");
    expect(defaults.policies["dynamodb:GetItem"]).toBe("allow");
    expect(defaults.policies["dynamodb:PutItem"]).toBe("deny");
    expect(defaults.policies["iam:CreateRole"]).toBe("deny");
    expect(defaults.policies["lambda:CreateFunction"]).toBe("deny");
    expect(defaults.policies["s3:GetObject"]).toBe("allow");
    expect(defaults.policies["s3:PutBucketAcl"]).toBe("deny");
    expect(defaults.policies["s3:PutObjectTagging"]).toBe("deny");
    expect(defaults.policies["sts:GetCallerIdentity"]).toBe("allow");

    const categories = getPermissionCategories("aws");
    expect(categories).not.toBeNull();
    expect(categories?.categories["apigateway:POST"]).toBe("apigateway");
    expect(categories?.categories["ec2:DescribeInstances"]).toBe("ec2");
    expect(categories?.categories["es:CreateDomain"]).toBe("es");
    expect(categories?.categories["iam:CreateRole"]).toBe("iam");
    expect(categories?.categories["kafka-cluster:CreateTopic"]).toBe(
      "kafka-cluster",
    );
    expect(categories?.categories["lambda:CreateFunction"]).toBe("lambda");
    expect(categories?.categories["s3:GetObject"]).toBe("s3");
    expect(categories?.categories["sts:GetCallerIdentity"]).toBe("sts");
    expect(categories?.displayOrder).toEqual(
      expect.arrayContaining(["apigateway", "ec2", "iam", "lambda", "s3"]),
    );
  });

  it("reports generated AWS mapping coverage", () => {
    const firewall = getConnectorFirewall("aws");
    const standardPermissions = firewall.apis[0]!.permissions ?? [];
    const s3VirtualHostedPermissions = firewall.apis[3]!.permissions ?? [];

    expect(awsGenerationStats).toStrictEqual({
      sourceServices: 424,
      generatedServices: 418,
      unsupportedProtocolServices: 3,
      totalOperations: 18505,
      mappedOperations: 18216,
      crossServiceAuthorizedActionMappings: 95,
      fallbackActionMappings: 0,
      unmappedOperations: 289,
      ambiguousOperations: 62,
      unsupportedOperations: 0,
      permissionCount: 17513,
      ruleCount: 19723,
      s3VirtualHostedPermissionCount: 72,
      s3VirtualHostedRuleCount: 93,
    });
    expect(awsGenerationStats.permissionCount).toBe(standardPermissions.length);
    expect(awsGenerationStats.ruleCount).toBe(countRules(standardPermissions));
    expect(awsGenerationStats.s3VirtualHostedPermissionCount).toBe(
      s3VirtualHostedPermissions.length,
    );
    expect(awsGenerationStats.s3VirtualHostedRuleCount).toBe(
      countRules(s3VirtualHostedPermissions),
    );
  });

  it("does not treat AWS predicate rules as plain path rules in the TypeScript matcher", () => {
    const firewall = getConnectorFirewall("aws");

    expect(findMatchingPermissions("GET", "/", firewall)).toStrictEqual([]);
    expect(
      findMatchingPermissions("GET", "/bucket/key", firewall),
    ).toStrictEqual([]);
  });

  it("matches common AWS-owned endpoints", () => {
    const urls = [
      "https://sts.amazonaws.com/",
      "https://iam.amazonaws.com/",
      "https://s3.amazonaws.com/",
      "https://s3.us-west-2.amazonaws.com/my-bucket",
      "https://my-bucket.s3.us-west-2.amazonaws.com/key",
      "https://s3.dualstack.us-west-2.amazonaws.com/my-bucket",
      "https://ec2.us-west-2.api.aws/",
      "https://iam.global.api.aws/",
      "https://sts.cn-north-1.amazonaws.com.cn/",
      "https://s3-fips.us-gov-west-1.amazonaws.com/",
    ];

    for (const url of urls) {
      expect(matchesAwsFirewall(url)).toBe(true);
    }
  });

  it("does not match custom S3-compatible or lookalike domains", () => {
    const urls = [
      "https://minio.example.com/my-bucket",
      "https://s3.amazonaws.com.evil.example/my-bucket",
      "https://evilamazonaws.com/",
      "https://api.aws.evil.example/",
    ];

    for (const url of urls) {
      expect(matchesAwsFirewall(url)).toBe(false);
    }
  });
});
