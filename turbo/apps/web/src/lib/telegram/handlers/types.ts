/**
 * Shared Telegram update type for handler functions.
 *
 * This represents the subset of a Telegram Update that is passed to
 * individual command/message handlers (i.e. the `{ message }` wrapper).
 * The webhook route parses the raw update and passes this shape down.
 */
export interface TelegramHandlerUpdate {
  message: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; is_bot?: boolean };
    text?: string;
    /** Present on group messages with @mentions or bot commands */
    entities?: Array<{ type: string; offset: number; length: number }>;
    /** Present when the user replies to another message */
    reply_to_message?: {
      message_id: number;
      from?: { id: number; is_bot?: boolean };
    };
  };
}
