import {
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
  DEFAULT_SKILLS_BRANCH,
} from "@vm0/core";

const SKILL_URL_PREFIX = `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/`;

export function skillUrlToValue(url: string): string {
  if (url.startsWith(SKILL_URL_PREFIX)) {
    return url.slice(SKILL_URL_PREFIX.length);
  }
  return url;
}
