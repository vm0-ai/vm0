export interface LazyLoaderEntry {
  readonly key: string;
  readonly moduleSpecifier: string;
  readonly exportName: string;
}

interface LazyLoaderRecordOptions {
  readonly constName: string;
  readonly recordType: string;
  readonly entries: readonly LazyLoaderEntry[];
}

function compareEntryKeys(a: LazyLoaderEntry, b: LazyLoaderEntry): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function renderLazyLoaderEntry(entry: LazyLoaderEntry): string {
  // Preserve a literal import in emitted JavaScript for bundlers while avoiding
  // TypeScript resolving every generated detail module during type-checking.
  return `  [${JSON.stringify(entry.key)}]: async () => {
    return (await import(${JSON.stringify(entry.moduleSpecifier)} as string))[${JSON.stringify(entry.exportName)}];
  },`;
}

function validateUniqueEntryKeys(entries: readonly LazyLoaderEntry[]): void {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.key)) {
      throw new Error(`Duplicate lazy loader key: ${entry.key}`);
    }
    keys.add(entry.key);
  }
}

export function renderLazyLoaderRecord({
  constName,
  recordType,
  entries,
}: LazyLoaderRecordOptions): string {
  validateUniqueEntryKeys(entries);

  const renderedEntries = [...entries]
    .sort(compareEntryKeys)
    .map(renderLazyLoaderEntry)
    .join("\n");

  return `const ${constName}: Readonly<
  ${recordType}
> = Object.assign(Object.create(null), {
${renderedEntries}
} satisfies Readonly<
  ${recordType}
>);`;
}
