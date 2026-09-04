import storageIds from "./presentation-template-storage-ids.json";

const presentationTemplateStorageIds: Readonly<Record<string, string>> =
  storageIds;

export function findPresentationTemplateStorageId(
  resourceId: string,
): string | undefined {
  return presentationTemplateStorageIds[resourceId];
}
