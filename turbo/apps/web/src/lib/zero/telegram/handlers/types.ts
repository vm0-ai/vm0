/**
 * Shared Telegram update type for handler functions.
 *
 * This represents the subset of a Telegram Update that is passed to
 * individual command/message handlers (i.e. the `{ message }` wrapper).
 * The webhook route parses the raw update and passes this shape down.
 */
interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramHandlerUpdate {
  message: {
    message_id: number;
    /** Present for messages in Telegram supergroup forum topics */
    message_thread_id?: number;
    chat: { id: number; type: string };
    from?: {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
      language_code?: string;
      is_bot?: boolean;
    };
    text?: string;
    /** Caption for photo/document messages */
    caption?: string;
    /** Photo sizes array — present when user sends a photo */
    photo?: TelegramPhotoSize[];
    /** Present on text messages with @mentions or bot commands */
    entities?: Array<{ type: string; offset: number; length: number }>;
    /** Present on photo/document captions with @mentions or bot commands */
    caption_entities?: Array<{ type: string; offset: number; length: number }>;
    /** Present when the user replies to another message */
    reply_to_message?: {
      message_id: number;
      from?: {
        id: number;
        is_bot?: boolean;
        username?: string;
        first_name?: string;
      };
      text?: string;
      caption?: string;
    };
  };
}
