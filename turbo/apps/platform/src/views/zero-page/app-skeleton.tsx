import { ZERO_AVATARS } from "./zero-avatars.ts";

const LOADING_MESSAGES = [
  "Warming up the neurons...",
  "Brewing some ideas...",
  "Getting things ready...",
  "Almost there...",
  "Loading your workspace...",
  "Tuning the instruments...",
  "Connecting the dots...",
  "Spinning up the team...",
] as const;

/** Pick once at module load so remounts don't flicker. */
const AVATAR_INDEX = Math.floor(Math.random() * ZERO_AVATARS.length);
const MSG_INDEX_1 = Math.floor(Math.random() * LOADING_MESSAGES.length);
const MSG_INDEX_2 = (MSG_INDEX_1 + 1) % LOADING_MESSAGES.length;
const STATIC_MSG = LOADING_MESSAGES[MSG_INDEX_1];
const TYPEWRITER_MSG = LOADING_MESSAGES[MSG_INDEX_2];
const CHAR_COUNT = TYPEWRITER_MSG.length;

/**
 * CSS-only typewriter: hidden for the first 800ms (shows static msg),
 * then types out the second message over 1.5s with a blinking caret.
 * The static message hides at the same 800ms mark.
 */
const skeletonCSS = `
@keyframes sk-typing {
  from { width: 0; }
  to { width: ${CHAR_COUNT}ch; }
}
@keyframes sk-blink {
  0%, 100% { border-color: transparent; }
  50% { border-color: currentColor; }
}
@keyframes sk-hide-static {
  0%, 99.9% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes sk-show-typewriter {
  0%, 99.9% { visibility: hidden; }
  100% { visibility: visible; }
}
`;

/**
 * Global loading screen shown during app bootstrap.
 * Shows a static message immediately; if loading takes >800ms,
 * swaps to a typewriter-animated second message.
 */
export function AppSkeleton({ visible = true }: { visible?: boolean }) {
  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-background ${
        visible
          ? "opacity-100"
          : "opacity-0 pointer-events-none transition-opacity duration-300"
      }`}
    >
      <style>{skeletonCSS}</style>
      <div className="flex flex-col items-center gap-5">
        <img
          src={ZERO_AVATARS[AVATAR_INDEX]}
          alt=""
          role="presentation"
          className="h-16 w-16 rounded-full object-cover object-top"
        />
        <div className="relative h-6">
          {/* Static message: visible immediately, hides at 800ms */}
          <p
            className="text-base font-medium text-foreground/70 whitespace-nowrap"
            style={{
              animation: "sk-hide-static 800ms forwards",
            }}
          >
            {STATIC_MSG}
          </p>
          {/* Typewriter message: appears at 800ms, types over 1.5s */}
          <p
            className="absolute inset-0 text-base font-medium text-foreground/70 overflow-hidden whitespace-nowrap border-r-2 border-current"
            style={{
              visibility: "hidden",
              width: 0,
              animation: `sk-show-typewriter 800ms forwards, sk-typing 1.5s steps(${CHAR_COUNT}) 800ms forwards, sk-blink 0.6s step-end 800ms infinite`,
            }}
          >
            {TYPEWRITER_MSG}
          </p>
        </div>
      </div>
    </div>
  );
}
