// Structural paste-event shape shared by the plain textarea composer and the
// TipTap skill composer. Both a React ClipboardEvent<HTMLTextAreaElement> and a
// native ClipboardEvent are assignable to this, so a single paste handler can
// serve both input surfaces without casting.
export interface ComposerPasteEvent {
  readonly clipboardData: DataTransfer | null;
  readonly currentTarget: HTMLElement;
  preventDefault(): void;
}
