import { describe, expect, it } from "vitest";

import { extractSecretNamesFromApis } from "../../firewall-types";
import { matchFirewallBaseUrl } from "../../firewall-rule-matcher";
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
  it("registers AWS as an auth-only SigV4 firewall connector", () => {
    expect(isFirewallConnectorType("aws")).toBe(true);
    const firewall = getConnectorFirewall("aws");

    expect(firewall.name).toBe("aws");
    expect(firewall.apis).toStrictEqual([
      {
        base: "https://{awsHost+}.amazonaws.com",
        auth: {
          awsSigv4: {
            accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",
            secretAccessKey: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            sessionToken: "${{ secrets.AWS_SESSION_TOKEN }}",
          },
        },
        permissions: [],
      },
      {
        base: "https://{awsHost+}.amazonaws.com.cn",
        auth: {
          awsSigv4: {
            accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",
            secretAccessKey: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            sessionToken: "${{ secrets.AWS_SESSION_TOKEN }}",
          },
        },
        permissions: [],
      },
      {
        base: "https://{awsHost+}.api.aws",
        auth: {
          awsSigv4: {
            accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",
            secretAccessKey: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            sessionToken: "${{ secrets.AWS_SESSION_TOKEN }}",
          },
        },
        permissions: [],
      },
    ]);
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
    expect(getDefaultFirewallPolicies("aws")).toStrictEqual({
      policies: {},
      unknownPolicy: "allow",
    });
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
