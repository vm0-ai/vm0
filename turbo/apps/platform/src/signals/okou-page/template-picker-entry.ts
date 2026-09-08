export type TemplatePickerEntryCategory =
  | "slides"
  | "illustration"
  | "video"
  | "explainer"
  | "website";

export function parseTemplatePickerEntryCategory(
  value: string | null,
  explainerEnabled: boolean,
): TemplatePickerEntryCategory | null {
  switch (value) {
    case "explainer": {
      return explainerEnabled ? value : null;
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
