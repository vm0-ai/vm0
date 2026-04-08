/**
 * Generate GitHub firewall config from GitHub's official permissions data,
 * augmented with GraphQL mutation field rules.
 *
 * REST data source: server-to-server-permissions.json from github/docs
 * (https://github.com/github/docs/tree/main/src/github-apps/data)
 *
 * GraphQL mutations are mapped to REST permission groups so that both
 * `gh api` (REST) and `gh issue create` (GraphQL) are covered by the
 * same named permission.
 */

import {
  fetchSpec,
  logStats,
  renderPermissions,
  sortRules,
  writeOutput,
} from "./codegen";
import type { PermissionGroup } from "./codegen";

const PERMS_URL =
  "https://raw.githubusercontent.com/github/docs/main/src/github-apps/data/fpt-2026-03-10/server-to-server-permissions.json";

const SCHEMA_URL =
  "https://raw.githubusercontent.com/octokit/graphql-schema/master/schema.json";

// ── Placeholder token generation ─────────────────────────────────────────
//
// GitHub tokens use CRC32 checksums for offline format validation.
// Structure: prefix (4 chars) + entropy (30 chars) + checksum (6 chars)
// Reference: https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62Encode(num: number, pad = 6): string {
  if (num === 0) return "0".repeat(pad);
  const digits: string[] = [];
  let n = num;
  while (n > 0) {
    digits.push(BASE62[n % 62]!);
    n = Math.floor(n / 62);
  }
  return digits.reverse().join("").padStart(pad, "0");
}

function crc32(data: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeGitHubPlaceholder(
  prefix = "gho_",
  entropy = "CoffeeSafeLocalCoffeeSafeLocal",
): string {
  return `${prefix}${entropy}${base62Encode(crc32(entropy))}`;
}

// ── Path conversion ──────────────────────────────────────────────────────

// Parameters that may contain slashes → greedy suffix.
const CATCH_ALL: [string, string][] = [
  ["/contents/{path}", "/contents/{path*}"],
  ["/git/ref/{ref}", "/git/ref/{ref+}"],
  ["/git/refs/{ref}", "/git/refs/{ref+}"],
  ["/git/matching-refs/{ref}", "/git/matching-refs/{ref+}"],
  ["/compare/{basehead}", "/compare/{basehead+}"],
];

function convertPath(p: string): string {
  for (const [old, replacement] of CATCH_ALL) {
    if (p.endsWith(old)) {
      return p.slice(0, -old.length) + replacement;
    }
  }
  return p;
}

// ── Types for permissions JSON ───────────────────────────────────────────

interface PermEndpoint {
  verb: string;
  requestPath: string;
  access: string;
}

interface PermEntry {
  title?: string;
  displayTitle?: string;
  permissions: PermEndpoint[];
}

type PermsData = Record<string, PermEntry>;

// ── GraphQL mutation → REST permission mapping ───────────────────────────
//
// Maps GraphQL mutation field names to REST permission group names.
// Ambiguous mutations (e.g., addReaction) are mapped to ALL applicable
// groups. Mutations without a mapping (Enterprise, Sponsorship, User
// account) are not included — they have no REST equivalent.

const MUTATION_TO_PERMISSIONS: Record<string, string[]> = {
  // administration:write
  archiveRepository: ["administration:write"],
  cloneTemplateRepository: ["administration:write"],
  createRepository: ["administration:write"],
  unarchiveRepository: ["administration:write"],
  updateRepository: ["administration:write"],
  updateRepositoryWebCommitSignoffSetting: ["administration:write"],
  updateTopics: ["administration:write"],
  createBranchProtectionRule: ["administration:write"],
  deleteBranchProtectionRule: ["administration:write"],
  updateBranchProtectionRule: ["administration:write"],
  createRepositoryRuleset: ["administration:write"],
  deleteRepositoryRuleset: ["administration:write"],
  updateRepositoryRuleset: ["administration:write"],

  // checks:write
  createCheckRun: ["checks:write"],
  createCheckSuite: ["checks:write"],
  rerequestCheckSuite: ["checks:write"],
  updateCheckRun: ["checks:write"],
  updateCheckSuitePreferences: ["checks:write"],

  // contents:write
  createCommitOnBranch: ["contents:write"],
  createRef: ["contents:write"],
  deleteRef: ["contents:write"],
  mergeBranch: ["contents:write"],
  updateRef: ["contents:write"],
  updateRefs: ["contents:write"],

  // deployments:write
  approveDeployments: ["deployments:write"],
  createDeployment: ["deployments:write"],
  createDeploymentStatus: ["deployments:write"],
  deleteDeployment: ["deployments:write"],
  rejectDeployments: ["deployments:write"],

  // environments:write
  createEnvironment: ["environments:write"],
  deleteEnvironment: ["environments:write"],
  pinEnvironment: ["environments:write"],
  reorderEnvironment: ["environments:write"],
  updateEnvironment: ["environments:write"],

  // interaction_limits:write
  setOrganizationInteractionLimit: ["interaction_limits:write"],
  setRepositoryInteractionLimit: ["interaction_limits:write"],
  setUserInteractionLimit: ["interaction_limits:write"],

  // issues:write
  createIssue: ["issues:write"],
  updateIssue: ["issues:write"],
  deleteIssue: ["issues:write"],
  closeIssue: ["issues:write"],
  reopenIssue: ["issues:write"],
  pinIssue: ["issues:write"],
  unpinIssue: ["issues:write"],
  transferIssue: ["issues:write"],
  unmarkIssueAsDuplicate: ["issues:write"],
  createLabel: ["issues:write"],
  updateLabel: ["issues:write"],
  deleteLabel: ["issues:write"],
  updateIssueComment: ["issues:write"],
  deleteIssueComment: ["issues:write"],

  // issues:write + pull_requests:write (ambiguous — target determined by node ID)
  addAssigneesToAssignable: ["issues:write", "pull_requests:write"],
  removeAssigneesFromAssignable: ["issues:write", "pull_requests:write"],
  addLabelsToLabelable: ["issues:write", "pull_requests:write"],
  removeLabelsFromLabelable: ["issues:write", "pull_requests:write"],
  clearLabelsFromLabelable: ["issues:write", "pull_requests:write"],
  lockLockable: ["issues:write", "pull_requests:write"],
  unlockLockable: ["issues:write", "pull_requests:write"],
  addReaction: ["issues:write", "pull_requests:write"],
  removeReaction: ["issues:write", "pull_requests:write"],
  addComment: ["issues:write", "pull_requests:write"],
  minimizeComment: ["issues:write", "pull_requests:write"],
  unminimizeComment: ["issues:write", "pull_requests:write"],

  // issues:write + contents:write
  createLinkedBranch: ["contents:write", "issues:write"],
  deleteLinkedBranch: ["contents:write", "issues:write"],

  // members:write
  removeOutsideCollaborator: ["members:write"],

  // metadata:write
  acceptTopicSuggestion: ["metadata:write"],
  declineTopicSuggestion: ["metadata:write"],

  // migrations:write
  abortQueuedMigrations: ["migrations:write"],
  abortRepositoryMigration: ["migrations:write"],
  createMigrationSource: ["migrations:write"],
  grantEnterpriseOrganizationsMigratorRole: ["migrations:write"],
  grantMigratorRole: ["migrations:write"],
  revokeEnterpriseOrganizationsMigratorRole: ["migrations:write"],
  revokeMigratorRole: ["migrations:write"],
  startOrganizationMigration: ["migrations:write"],
  startRepositoryMigration: ["migrations:write"],

  // notifications:write
  markNotificationAsDone: ["notifications:write"],
  unsubscribeFromNotifications: ["notifications:write"],
  updateSubscription: ["notifications:write"],

  // organization_administration:write
  addVerifiableDomain: ["organization_administration:write"],
  approveVerifiableDomain: ["organization_administration:write"],
  deleteVerifiableDomain: ["organization_administration:write"],
  regenerateVerifiableDomainToken: ["organization_administration:write"],
  verifyVerifiableDomain: ["organization_administration:write"],
  updateOrganizationAllowPrivateRepositoryForkingSetting: [
    "organization_administration:write",
  ],
  updateOrganizationWebCommitSignoffSetting: [
    "organization_administration:write",
  ],
  createIpAllowListEntry: ["organization_administration:write"],
  deleteIpAllowListEntry: ["organization_administration:write"],
  updateIpAllowListEnabledSetting: ["organization_administration:write"],
  updateIpAllowListEntry: ["organization_administration:write"],
  updateIpAllowListForInstalledAppsEnabledSetting: [
    "organization_administration:write",
  ],
  createAttributionInvitation: ["organization_administration:write"],
  updateNotificationRestrictionSetting: ["organization_administration:write"],

  // organization_projects:write (classic projects)
  addProjectCard: ["organization_projects:write"],
  addProjectColumn: ["organization_projects:write"],
  cloneProject: ["organization_projects:write"],
  convertProjectCardNoteToIssue: [
    "organization_projects:write",
    "issues:write",
  ],
  createProject: ["organization_projects:write"],
  deleteProject: ["organization_projects:write"],
  deleteProjectCard: ["organization_projects:write"],
  deleteProjectColumn: ["organization_projects:write"],
  importProject: ["organization_projects:write"],
  linkRepositoryToProject: ["organization_projects:write"],
  moveProjectCard: ["organization_projects:write"],
  moveProjectColumn: ["organization_projects:write"],
  unlinkRepositoryFromProject: ["organization_projects:write"],
  updateProject: ["organization_projects:write"],
  updateProjectCard: ["organization_projects:write"],
  updateProjectColumn: ["organization_projects:write"],

  // organization_projects:write (Projects V2)
  addProjectV2DraftIssue: ["organization_projects:write"],
  addProjectV2ItemById: ["organization_projects:write"],
  archiveProjectV2Item: ["organization_projects:write"],
  clearProjectV2ItemFieldValue: ["organization_projects:write"],
  convertProjectV2DraftIssueItemToIssue: [
    "organization_projects:write",
    "issues:write",
  ],
  copyProjectV2: ["organization_projects:write"],
  createProjectV2: ["organization_projects:write"],
  createProjectV2Field: ["organization_projects:write"],
  createProjectV2StatusUpdate: ["organization_projects:write"],
  deleteProjectV2: ["organization_projects:write"],
  deleteProjectV2Field: ["organization_projects:write"],
  deleteProjectV2Item: ["organization_projects:write"],
  deleteProjectV2StatusUpdate: ["organization_projects:write"],
  deleteProjectV2Workflow: ["organization_projects:write"],
  linkProjectV2ToRepository: ["organization_projects:write"],
  linkProjectV2ToTeam: ["organization_projects:write"],
  markProjectV2AsTemplate: ["organization_projects:write"],
  unarchiveProjectV2Item: ["organization_projects:write"],
  unlinkProjectV2FromRepository: ["organization_projects:write"],
  unlinkProjectV2FromTeam: ["organization_projects:write"],
  unmarkProjectV2AsTemplate: ["organization_projects:write"],
  updateProjectV2: ["organization_projects:write"],
  updateProjectV2Collaborators: ["organization_projects:write"],
  updateProjectV2DraftIssue: ["organization_projects:write"],
  updateProjectV2ItemFieldValue: ["organization_projects:write"],
  updateProjectV2ItemPosition: ["organization_projects:write"],
  updateProjectV2StatusUpdate: ["organization_projects:write"],

  // packages:write
  deletePackageVersion: ["packages:write"],

  // pull_requests:write
  addPullRequestReview: ["pull_requests:write"],
  addPullRequestReviewComment: ["pull_requests:write"],
  addPullRequestReviewThread: ["pull_requests:write"],
  addPullRequestReviewThreadReply: ["pull_requests:write"],
  closePullRequest: ["pull_requests:write"],
  convertPullRequestToDraft: ["pull_requests:write"],
  createPullRequest: ["pull_requests:write"],
  deletePullRequestReview: ["pull_requests:write"],
  deletePullRequestReviewComment: ["pull_requests:write"],
  dequeuePullRequest: ["pull_requests:write"],
  disablePullRequestAutoMerge: ["pull_requests:write"],
  dismissPullRequestReview: ["pull_requests:write"],
  enablePullRequestAutoMerge: ["pull_requests:write"],
  enqueuePullRequest: ["pull_requests:write"],
  markFileAsViewed: ["pull_requests:write"],
  markPullRequestReadyForReview: ["pull_requests:write"],
  mergePullRequest: ["pull_requests:write", "contents:write"],
  reopenPullRequest: ["pull_requests:write"],
  requestReviews: ["pull_requests:write"],
  resolveReviewThread: ["pull_requests:write"],
  revertPullRequest: ["pull_requests:write"],
  submitPullRequestReview: ["pull_requests:write"],
  unmarkFileAsViewed: ["pull_requests:write"],
  unresolveReviewThread: ["pull_requests:write"],
  updatePullRequest: ["pull_requests:write"],
  updatePullRequestBranch: ["pull_requests:write", "contents:write"],
  updatePullRequestReview: ["pull_requests:write"],
  updatePullRequestReviewComment: ["pull_requests:write"],

  // starring:write
  addStar: ["starring:write"],
  removeStar: ["starring:write"],

  // teams:write
  createTeamDiscussion: ["teams:write"],
  createTeamDiscussionComment: ["teams:write"],
  deleteTeamDiscussion: ["teams:write"],
  deleteTeamDiscussionComment: ["teams:write"],
  updateTeamDiscussion: ["teams:write"],
  updateTeamDiscussionComment: ["teams:write"],
  updateTeamReviewAssignment: ["teams:write"],
  updateTeamsRepository: ["teams:write"],

  // vulnerability_alerts:write
  dismissRepositoryVulnerabilityAlert: ["vulnerability_alerts:write"],

  // discussions:write (partial — GraphQL-first feature)
  addDiscussionComment: ["discussions:write"],
  addDiscussionPollVote: ["discussions:write"],
  addUpvote: ["discussions:write"],
  closeDiscussion: ["discussions:write"],
  createDiscussion: ["discussions:write"],
  deleteDiscussion: ["discussions:write"],
  deleteDiscussionComment: ["discussions:write"],
  markDiscussionCommentAsAnswer: ["discussions:write"],
  reopenDiscussion: ["discussions:write"],
  removeUpvote: ["discussions:write"],
  unmarkDiscussionCommentAsAnswer: ["discussions:write"],
  updateDiscussion: ["discussions:write"],
  updateDiscussionComment: ["discussions:write"],
};

// ── Skipped mutations ────────────────────────────────────────────────────
//
// Mutations with no REST fine-grained permission equivalent.
// Maintained explicitly so the generator fails when GitHub adds new
// mutations that need classification.

function isSkippedMutation(name: string): boolean {
  // Enterprise administration — requires classic PAT, no fine-grained support.
  if (/[Ee]nterprise/.test(name) && !/[Mm]igrat/.test(name)) return true;
  // Sponsorship — no fine-grained PAT permission.
  if (/[Ss]ponsor|[Pp]atreon/.test(name)) return true;
  // User account operations — not repo/org scoped.
  if (SKIPPED_USER_MUTATIONS.has(name)) return true;
  return false;
}

const SKIPPED_USER_MUTATIONS = new Set([
  "changeUserStatus",
  "createUserList",
  "deleteUserList",
  "followOrganization",
  "followUser",
  "unfollowOrganization",
  "unfollowUser",
  "updateUserList",
  "updateUserListsForItem",
]);

// ── Schema validation ───────────────────────────────────────────────────

interface SchemaType {
  name: string;
  fields?: Array<{ name: string }>;
}

interface IntrospectionResult {
  __schema: {
    types: SchemaType[];
  };
}

/**
 * Fetch all mutation field names from the GitHub GraphQL schema and
 * verify that every mutation is either mapped or explicitly skipped.
 */
async function validateMutationCoverage(): Promise<void> {
  const res = await fetchSpec(SCHEMA_URL, "GitHub GraphQL schema");
  const schema = (await res.json()) as IntrospectionResult;
  const mutationType = schema.__schema.types.find((t) => {
    return t.name === "Mutation";
  });
  if (!mutationType?.fields) {
    throw new Error("Could not find Mutation type in GraphQL schema");
  }

  const allMutations = mutationType.fields.map((f) => f.name);
  console.error(`  ${allMutations.length} GraphQL mutations in schema`);

  const unmapped: string[] = [];
  for (const name of allMutations) {
    if (MUTATION_TO_PERMISSIONS[name]) continue;
    if (isSkippedMutation(name)) continue;
    unmapped.push(name);
  }

  if (unmapped.length > 0) {
    throw new Error(
      `${unmapped.length} unmapped GraphQL mutation(s) — add to MUTATION_TO_PERMISSIONS or mark as skipped:\n  ${unmapped.join("\n  ")}`,
    );
  }

  const mapped = Object.keys(MUTATION_TO_PERMISSIONS).length;
  const skipped = allMutations.length - mapped;
  console.error(`  ${mapped} mapped, ${skipped} skipped`);
}

// ── Grouping ─────────────────────────────────────────────────────────────

/**
 * Build a reverse index: permission group name → mutation field names.
 */
function buildMutationIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [mutation, groups] of Object.entries(MUTATION_TO_PERMISSIONS)) {
    for (const group of groups) {
      let list = index.get(group);
      if (!list) {
        list = [];
        index.set(group, list);
      }
      list.push(mutation);
    }
  }
  // Sort mutation names within each group for deterministic output.
  for (const list of index.values()) {
    list.sort();
  }
  return index;
}

function buildGroups(permsData: PermsData): PermissionGroup[] {
  const groups = new Map<string, Set<string>>();
  const descriptions = new Map<string, string>();

  for (const [permKey, entry] of Object.entries(permsData)) {
    const title = entry.title ?? entry.displayTitle ?? "";
    for (const ep of entry.permissions) {
      if (!ep.verb || !ep.requestPath || !ep.access) {
        throw new Error(
          `Endpoint missing verb/requestPath/access in permission "${permKey}": ${JSON.stringify(ep)}`,
        );
      }
      const groupName = `${permKey}:${ep.access}`;
      let ruleSet = groups.get(groupName);
      if (!ruleSet) {
        ruleSet = new Set();
        groups.set(groupName, ruleSet);
      }
      const fwPath = convertPath(ep.requestPath);
      ruleSet.add(`${ep.verb.toUpperCase()} ${fwPath}`);
      if (!descriptions.has(groupName)) {
        descriptions.set(groupName, title);
      }
    }
  }

  // Add GraphQL mutation field rules to matching permission groups.
  const mutationIndex = buildMutationIndex();
  for (const [groupName, mutations] of mutationIndex) {
    let ruleSet = groups.get(groupName);
    if (!ruleSet) {
      // Permission group exists only in GraphQL (e.g., discussions:write).
      // Create a new group for it.
      ruleSet = new Set();
      groups.set(groupName, ruleSet);
    }
    for (const mutation of mutations) {
      ruleSet.add(`POST /graphql GraphQL type:mutation field:${mutation}`);
    }
  }

  return [...groups.entries()]
    .filter(([, ruleSet]) => ruleSet.size > 0)
    .map(([name, ruleSet]) => ({
      name,
      description: descriptions.get(name) ?? "",
      rules: sortRules([...ruleSet]),
    }));
}

// ── TypeScript generation ────────────────────────────────────────────────

function generateTypeScript(permissions: PermissionGroup[]): string {
  const placeholder = makeGitHubPlaceholder();

  const lines: string[] = [
    "// Auto-generated from GitHub's official permissions data + GraphQL schema.",
    "// Source: github/docs/src/github-apps/data/fpt-2026-03-10/server-to-server-permissions.json",
    "// GraphQL: mutation field names mapped to REST permission groups",
    `// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:github`,
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../contracts/firewalls";',
    "",
    "export const githubFirewall = {",
    '  name: "github",',
    '  description: "GitHub API",',
    "  placeholders: {",
    `    GITHUB_TOKEN: "${placeholder}",`,
    `    GH_TOKEN: "${placeholder}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://api.github.com",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.GITHUB_TOKEN }}",',
    "        },",
    "      },",
    "      permissions: [",
  ];

  lines.push(...renderPermissions(permissions));

  lines.push("      ],");
  lines.push("    },");

  // uploads.github.com — release asset upload endpoint.
  lines.push("    {");
  lines.push('      base: "https://uploads.github.com",');
  lines.push("      auth: {");
  lines.push("        headers: {");
  lines.push('          Authorization: "Bearer ${{ secrets.GITHUB_TOKEN }}",');
  lines.push("        },");
  lines.push("      },");
  lines.push("      permissions: [");
  lines.push("        {");
  lines.push('          name: "contents:write",');
  lines.push('          description: "Upload release assets",');
  lines.push("          rules: [");
  lines.push(
    '            "POST /repos/{owner}/{repo}/releases/{release_id}/assets",',
  );
  lines.push("          ],");
  lines.push("        },");
  lines.push("      ],");
  lines.push("    },");
  lines.push("  ],");
  lines.push("} as const satisfies FirewallConfig;");
  lines.push("");

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function generate(): Promise<void> {
  const [permsRes] = await Promise.all([
    fetchSpec(PERMS_URL, "GitHub permissions data"),
    validateMutationCoverage(),
  ]);
  const permsData = (await permsRes.json()) as PermsData;
  console.error(`  ${Object.keys(permsData).length} REST permissions`);

  const permissions = buildGroups(permsData);
  const ts = generateTypeScript(permissions);

  logStats(permissions);
  writeOutput("github", ts, import.meta.dirname);
}
