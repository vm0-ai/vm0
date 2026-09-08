import { Command, InvalidArgumentError } from "commander";

import {
  listWebIntroVideoAvatars,
  listWebIntroVideoStyles,
  listWebIntroVideoVoices,
} from "../lib/api/domains/web";
import { withErrorHandler } from "../lib/command/with-error-handler";

type IntroVideoCatalog = "avatars" | "styles" | "voices";
type IntroVideoVoiceGender = "female" | "male";

interface IntroVideoCatalogCommandOptions {
  readonly gender?: IntroVideoVoiceGender;
  readonly json?: boolean;
  readonly language?: string;
  readonly pageSize: number;
  readonly token?: string;
}

function parseCatalog(value: string): IntroVideoCatalog {
  if (value === "avatars" || value === "styles" || value === "voices") {
    return value;
  }
  throw new InvalidArgumentError(
    "catalog must be one of: avatars, styles, voices",
  );
}

function parsePageSize(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new InvalidArgumentError(
      "page size must be an integer from 1 to 100",
    );
  }
  return parsed;
}

function parseGender(value: string): IntroVideoVoiceGender {
  if (value === "female" || value === "male") {
    return value;
  }
  throw new InvalidArgumentError("gender must be female or male");
}

async function runIntroVideoCatalogCommand(
  catalog: IntroVideoCatalog,
  options: IntroVideoCatalogCommandOptions,
): Promise<void> {
  const common = {
    pageSize: options.pageSize,
    ...(options.token ? { token: options.token } : {}),
  };
  const result =
    catalog === "avatars"
      ? await listWebIntroVideoAvatars(common)
      : catalog === "styles"
        ? await listWebIntroVideoStyles(common)
        : await listWebIntroVideoVoices({
            ...common,
            ...(options.language ? { language: options.language } : {}),
            ...(options.gender ? { gender: options.gender } : {}),
          });
  console.log(JSON.stringify(result, null, options.json ? undefined : 2));
}

export const introVideoCatalogCommand = new Command()
  .name("__intro-video-catalog")
  .description("Internal public HeyGen catalog discovery for Intro Video")
  .argument("<catalog>", "avatars, styles, or voices", parseCatalog)
  .option("--page-size <count>", "Catalog page size", parsePageSize, 100)
  .option("--token <token>", "HeyGen pagination token")
  .option("--language <language>", "Voice language filter")
  .option("--gender <gender>", "Voice gender filter", parseGender)
  .option("--json", "Print compact JSON")
  .action(withErrorHandler(runIntroVideoCatalogCommand));
