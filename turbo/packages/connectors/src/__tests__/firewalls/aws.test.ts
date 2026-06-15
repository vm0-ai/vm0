import { describe, expect, it } from "vitest";

import { extractSecretNamesFromApis } from "../../firewall-types";
import {
  findMatchingPermissions,
  matchFirewallBaseUrl,
} from "../../firewall-rule-matcher";
import {
  getConnectorFirewall,
  getDefaultFirewallPolicies,
  isFirewallConnectorType,
} from "../../firewalls/index";

const FORBIDDEN_PLACEHOLDER_WORD_RE = /placeholder|fake|dummy|test|example/i;

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

describe("aws firewall", () => {
  it("registers AWS as a SigV4 firewall connector with generated permissions", () => {
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

    const standardApis = firewall.apis.slice(0, 3);
    for (const api of standardApis) {
      expect(
        api.permissions?.map((permission) => {
          return permission.name;
        }),
      ).toEqual(
        expect.arrayContaining([
          "ec2:DescribeInstances",
          "ec2:RunInstances",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "s3:GetObject",
          "s3:GetObjectTagging",
          "s3:PutBucketAcl",
        ]),
      );
    }

    const virtualHostedApis = firewall.apis.slice(3);
    for (const api of virtualHostedApis) {
      expect(
        api.permissions?.map((permission) => {
          return permission.name;
        }),
      ).toStrictEqual([
        "s3:GetBucketAcl",
        "s3:GetBucketPolicy",
        "s3:GetObject",
        "s3:GetObjectTagging",
        "s3:PutBucketAcl",
        "s3:PutBucketPolicy",
        "s3:PutObject",
        "s3:PutObjectTagging",
      ]);
    }

    const permissions = standardApis[0]!.permissions ?? [];
    expect(
      permissions.find((permission) => {
        return permission.name === "ec2:DescribeInstances";
      })?.rules,
    ).toStrictEqual([
      "GET / AWS sigv4=ec2 action=DescribeInstances",
      "POST / AWS sigv4=ec2 action=DescribeInstances",
    ]);
    expect(
      permissions.find((permission) => {
        return permission.name === "dynamodb:GetItem";
      })?.rules,
    ).toStrictEqual([
      "POST / AWS sigv4=dynamodb target=DynamoDB_20120810.GetItem",
    ]);
    expect(
      permissions.find((permission) => {
        return permission.name === "s3:GetObjectTagging";
      })?.rules,
    ).toStrictEqual(["GET /{Bucket}/{Key+}?tagging AWS sigv4=s3"]);

    const virtualHostedPermissions = virtualHostedApis[0]!.permissions ?? [];
    expect(
      virtualHostedPermissions.find((permission) => {
        return permission.name === "s3:GetBucketAcl";
      })?.rules,
    ).toStrictEqual(["GET /?acl AWS sigv4=s3"]);
    expect(
      virtualHostedPermissions.find((permission) => {
        return permission.name === "s3:GetObject";
      })?.rules,
    ).toStrictEqual(["GET /{Key+} AWS sigv4=s3"]);
    expect(
      virtualHostedPermissions.find((permission) => {
        return permission.name === "s3:GetObjectTagging";
      })?.rules,
    ).toStrictEqual(["GET /{Key+}?tagging AWS sigv4=s3"]);

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

    const defaults = getDefaultFirewallPolicies("aws");
    expect(defaults.unknownPolicy).toBe("allow");
    expect(defaults.policies["ec2:DescribeInstances"]).toBe("allow");
    expect(defaults.policies["ec2:RunInstances"]).toBe("deny");
    expect(defaults.policies["ec2:CreateTags"]).toBe("deny");
    expect(defaults.policies["dynamodb:GetItem"]).toBe("allow");
    expect(defaults.policies["dynamodb:PutItem"]).toBe("deny");
    expect(defaults.policies["s3:GetObject"]).toBe("allow");
    expect(defaults.policies["s3:PutBucketAcl"]).toBe("deny");
    expect(defaults.policies["s3:PutObjectTagging"]).toBe("deny");
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
