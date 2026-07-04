import chalk from "chalk";
import type { RelationshipRecord } from "@vm0/api-contracts/contracts/zero-relationships";

function formatDate(value: string | null): string {
  if (!value) {
    return "never";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function itemsOfKind(
  relationship: RelationshipRecord,
  kind: RelationshipRecord["items"][number]["kind"],
) {
  return relationship.items.filter((item) => {
    return item.kind === kind;
  });
}

function printItems(
  title: string,
  items: readonly RelationshipRecord["items"][number][],
): void {
  if (items.length === 0) {
    return;
  }
  console.log("");
  console.log(chalk.bold(title));
  for (const item of items) {
    const source = item.sources[0];
    const sourceText = source
      ? chalk.dim(` (${source.provider}, ${formatDate(source.occurredAt)})`)
      : "";
    console.log(`  - ${item.text}${sourceText}`);
  }
}

export function printRelationship(relationship: RelationshipRecord): void {
  console.log(chalk.green("✓ Relationship loaded"));
  console.log(chalk.bold(relationship.entity.displayName));
  if (relationship.entity.primaryEmail) {
    console.log(chalk.dim(`  Email: ${relationship.entity.primaryEmail}`));
  }
  if (relationship.entity.domain) {
    console.log(chalk.dim(`  Domain: ${relationship.entity.domain}`));
  }
  console.log(chalk.dim(`  Type: ${relationship.relationshipType}`));
  console.log(chalk.dim(`  Status: ${relationship.status}`));
  console.log(
    chalk.dim(`  Last touch: ${formatDate(relationship.lastInteractionAt)}`),
  );

  if (relationship.summary) {
    console.log("");
    console.log(relationship.summary);
  }

  printItems("Key facts", itemsOfKind(relationship, "key_fact"));
  printItems("Preferences", itemsOfKind(relationship, "preference"));
  printItems("Open loops", itemsOfKind(relationship, "open_loop"));
}

export function printRelationshipSearch(
  relationships: readonly RelationshipRecord[],
): void {
  if (relationships.length === 0) {
    console.log("No relationships found");
    return;
  }

  console.log(chalk.green(`✓ Found ${relationships.length} relationships`));
  for (const relationship of relationships) {
    const primary =
      relationship.entity.primaryEmail ?? relationship.entity.domain ?? "";
    const suffix = primary ? chalk.dim(` - ${primary}`) : "";
    console.log(
      `${relationship.entity.displayName}${suffix} ${chalk.dim(
        `(${relationship.relationshipType}, ${formatDate(
          relationship.lastInteractionAt,
        )})`,
      )}`,
    );
    if (relationship.summary) {
      console.log(chalk.dim(`  ${relationship.summary}`));
    }
  }
}
