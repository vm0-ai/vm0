const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>\\]+/giu;
const PRESIGNED_QUERY_PARAMETER_PATTERN =
  /(?:^|&)(?:X-Amz-[A-Za-z0-9-]+|AWSAccessKeyId|Signature)=/iu;

export function redactPresignedUrls(value: string): string {
  return value.replace(URL_PATTERN, (url) => {
    const query = url.split("?", 2)[1];
    return query && PRESIGNED_QUERY_PARAMETER_PATTERN.test(query)
      ? "[redacted presigned URL]"
      : url;
  });
}
