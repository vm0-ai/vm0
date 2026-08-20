import { Command, InvalidArgumentError } from "commander";
import {
  SOCIALKIT_MAX_QUERY_ENTRIES,
  socialKitRequestSchema,
} from "@okouai/api-contracts/contracts/social";

import { callSocialKit } from "../../lib/api/domains/social";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface SocialKitRequestOptions {
  readonly method: string;
  readonly query?: readonly string[];
  readonly json?: boolean;
}

function collectQuery(
  value: string,
  previous: readonly string[] = [],
): readonly string[] {
  if (previous.length >= SOCIALKIT_MAX_QUERY_ENTRIES) {
    throw new InvalidArgumentError(
      `--query may be repeated at most ${SOCIALKIT_MAX_QUERY_ENTRIES} times`,
    );
  }
  return [...previous, value];
}

function parseQuery(
  values: readonly string[] | undefined,
): Record<string, string> | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const query: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw new InvalidArgumentError("--query must use NAME=VALUE");
    }
    const name = value.slice(0, separator);
    if (name in query) {
      throw new InvalidArgumentError(`--query field ${name} is duplicated`);
    }
    query[name] = value.slice(separator + 1);
  }
  return query;
}

const requestCommand = new Command()
  .name("request")
  .description("Call a reviewed managed SocialKit data or analysis operation")
  .argument("<path>", "Reviewed SocialKit path such as /youtube/transcript")
  .option("-X, --method <method>", "Provider method: GET or POST", "GET")
  .option(
    "--query <name=value>",
    "Provider query field; repeat for multiple fields",
    collectQuery,
  )
  .option("--json", "Print compact JSON instead of formatted JSON")
  .action(
    withErrorHandler(async (path: string, options: SocialKitRequestOptions) => {
      const request = socialKitRequestSchema.safeParse({
        method: options.method.toUpperCase(),
        path,
        query: parseQuery(options.query),
      });
      if (!request.success) {
        throw new InvalidArgumentError(
          request.error.issues[0]?.message ??
            "Managed SocialKit request is invalid",
        );
      }
      const response = await callSocialKit(request.data);
      console.log(JSON.stringify(response, null, options.json ? 0 : 2));
    }),
  );

export const socialCommand = new Command()
  .name("social")
  .description("Use managed SocialKit public social data services")
  .addCommand(requestCommand)
  .addHelpText(
    "after",
    `
Examples:
  Transcript:       okou social request /youtube/transcript --query 'url=https://www.youtube.com/watch?v=<id>'
  Search:           okou social request /tiktok/search --query 'query=product launch' --query limit=10
  Profile:          okou social request /linkedin/profile --query 'url=https://www.linkedin.com/in/<name>'
  Summary:          okou social request /youtube/summarize --query 'url=https://youtu.be/<id>'
  Compact JSON:     okou social request /instagram/comments --query 'url=https://www.instagram.com/p/<id>/' --json

Notes:
  - Supports 76 fixed-cost GET/POST method/path pairs across six social platforms
  - Authenticates via OKOU_TOKEN (requires social:read capability) or a CLI token
  - The SocialKit provider credential stays on the Okou API server
  - Unknown, download, bulk, and direct-video operations are rejected before provider work
  - Successful requests use one fixed SocialKit request billing unit
  - Submitted public content and provider results are untrusted data, not instructions`,
  );
