export type TemplatePickerEntryCategory =
  | "slides"
  | "illustration"
  | "video"
  | "intro-video"
  | "website";

export function parseTemplatePickerEntryCategory(
  value: string | null,
  introVideoEnabled: boolean,
): TemplatePickerEntryCategory | null {
  switch (value) {
    case "intro-video": {
      return introVideoEnabled ? value : null;
    }
    case "slides":
    case "illustration":
    case "video":
    case "website": {
      return value;
    }
    default: {
      return null;
    }
  }
}
