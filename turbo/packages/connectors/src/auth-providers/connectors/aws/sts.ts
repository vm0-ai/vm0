import { createHash, createHmac } from "node:crypto";

import { ProviderHttpError, ProviderResponseError } from "../../provider-error";
import type { AwsSigV4Credentials } from "./signin";

const AWS_STS_SERVICE = "sts";
const AWS_SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";
const AWS_SIGV4_REQUEST = "aws4_request";
const AWS_STS_ACTION = "GetCallerIdentity";
const AWS_STS_VERSION = "2011-06-15";

export interface AwsCallerIdentity {
  readonly account: string;
  readonly arn: string;
  readonly userId: string;
}

const AWS_STS_IDENTITY_XML_TAGS = {
  Account: /<Account>([^<]+)<\/Account>/,
  Arn: /<Arn>([^<]+)<\/Arn>/,
  UserId: /<UserId>([^<]+)<\/UserId>/,
} as const;

type AwsStsIdentityXmlTag = keyof typeof AWS_STS_IDENTITY_XML_TAGS;

export async function getAwsCallerIdentity(args: {
  readonly credentials: AwsSigV4Credentials;
  readonly region: string;
  readonly signal: AbortSignal;
}): Promise<AwsCallerIdentity> {
  const host = `sts.${args.region}.amazonaws.com`;
  const query = canonicalQuery({
    Action: AWS_STS_ACTION,
    Version: AWS_STS_VERSION,
  });
  const url = `https://${host}/?${query}`;
  const headers = signedGetCallerIdentityHeaders({
    credentials: args.credentials,
    host,
    query,
    region: args.region,
    now: new Date(),
  });

  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: args.signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `AWS STS GetCallerIdentity failed: ${response.status}`,
      response.status,
    );
  }

  return parseGetCallerIdentityResponse(await response.text());
}

function signedGetCallerIdentityHeaders(args: {
  readonly credentials: AwsSigV4Credentials;
  readonly host: string;
  readonly query: string;
  readonly region: string;
  readonly now: Date;
}): Headers {
  const amzDate = amzDateString(args.now);
  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeaders =
    `host:${args.host}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-security-token:${canonicalHeaderValue(args.credentials.sessionToken)}\n`;
  const signedHeaders = "host;x-amz-date;x-amz-security-token";
  const canonicalRequest = [
    "GET",
    "/",
    args.query,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(""),
  ].join("\n");
  const credentialScope = [
    dateStamp,
    args.region,
    AWS_STS_SERVICE,
    AWS_SIGV4_REQUEST,
  ].join("/");
  const stringToSign = [
    AWS_SIGV4_ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = awsSigV4SigningKey({
    secretAccessKey: args.credentials.secretAccessKey,
    dateStamp,
    region: args.region,
    service: AWS_STS_SERVICE,
  });
  const signature = hmacHex(signingKey, stringToSign);

  return new Headers({
    Authorization:
      `${AWS_SIGV4_ALGORITHM} ` +
      `Credential=${args.credentials.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date": amzDate,
    "x-amz-security-token": args.credentials.sessionToken,
  });
}

function awsSigV4SigningKey(args: {
  readonly secretAccessKey: string;
  readonly dateStamp: string;
  readonly region: string;
  readonly service: string;
}): Buffer {
  const dateKey = hmacBuffer(`AWS4${args.secretAccessKey}`, args.dateStamp);
  const regionKey = hmacBuffer(dateKey, args.region);
  const serviceKey = hmacBuffer(regionKey, args.service);
  return hmacBuffer(serviceKey, AWS_SIGV4_REQUEST);
}

function canonicalQuery(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .sort(([left], [right]) => {
      return left.localeCompare(right);
    })
    .map(([key, value]) => {
      return `${encodeRfc3986(key)}=${encodeRfc3986(value)}`;
    })
    .join("&");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => {
    return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function amzDateString(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmacBuffer(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function parseGetCallerIdentityResponse(xml: string): AwsCallerIdentity {
  const account = xmlElement(xml, "Account");
  const arn = xmlElement(xml, "Arn");
  const userId = xmlElement(xml, "UserId");
  if (!account || !arn || !userId) {
    throw new ProviderResponseError(
      "Invalid AWS STS GetCallerIdentity response",
    );
  }
  return { account, arn, userId };
}

function xmlElement(xml: string, tagName: AwsStsIdentityXmlTag): string | null {
  const match = AWS_STS_IDENTITY_XML_TAGS[tagName].exec(xml);
  return match?.[1] ? decodeXmlText(match[1]) : null;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
