export const COMPOSER_VOICE_INPUT_SHORTCUT = "mod+shift+e";

export const COMPOSER_VOICE_INPUT_ARIA_KEY_SHORTCUTS =
  "Meta+Shift+E Control+Shift+E";

const COMPOSER_VOICE_INPUT_SELECTOR = `[aria-keyshortcuts="${COMPOSER_VOICE_INPUT_ARIA_KEY_SHORTCUTS}"]`;

export function clickComposerVoiceInput(root: ParentNode): void {
  root.querySelector<HTMLButtonElement>(COMPOSER_VOICE_INPUT_SELECTOR)?.click();
}
