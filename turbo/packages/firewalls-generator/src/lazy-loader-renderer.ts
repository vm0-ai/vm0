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
  return `  ${JSON.stringify(entry.key)}: async () => {
    return (await import(${JSON.stringify(entry.moduleSpecifier)})).${entry.exportName};
  },`;
}

export function renderLazyLoaderRecord({
  constName,
  recordType,
  entries,
}: LazyLoaderRecordOptions): string {
  const renderedEntries = [...entries]
    .sort(compareEntryKeys)
    .map(renderLazyLoaderEntry)
    .join("\n");

  return `const ${constName}: Readonly<
  ${recordType}
> = {
${renderedEntries}
};`;
}
