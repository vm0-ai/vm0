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

interface TelegramFileBase {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
}

interface TelegramDocument extends TelegramFileBase {
  file_name?: string;
  mime_type?: string;
}

interface TelegramVideo extends TelegramFileBase {
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
}

interface TelegramAudio extends TelegramFileBase {
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
}

interface TelegramVoice extends TelegramFileBase {
  duration: number;
  mime_type?: string;
}

interface TelegramAnimation extends TelegramFileBase {
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
}

interface TelegramVideoNote extends TelegramFileBase {
  length: number;
  duration: number;
}

interface TelegramSticker extends TelegramFileBase {
  type?: string;
  width: number;
  height: number;
  emoji?: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
  custom_emoji_id?: string;
  user?: {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
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
    document?: TelegramDocument;
    video?: TelegramVideo;
    audio?: TelegramAudio;
    voice?: TelegramVoice;
    animation?: TelegramAnimation;
    video_note?: TelegramVideoNote;
    sticker?: TelegramSticker;
    /** Present on text messages with @mentions or bot commands */
    entities?: TelegramMessageEntity[];
    /** Present on photo/document captions with @mentions or bot commands */
    caption_entities?: TelegramMessageEntity[];
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
