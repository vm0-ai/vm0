import { useGet } from "ccstate-react";
import { ZERO_AVATARS } from "./zero-avatars.ts";
import { skeletonMessages$ } from "../../signals/app-skeleton.ts";

/** Pick once at module load so remounts don't flicker. */
const AVATAR_INDEX = Math.floor(Math.random() * ZERO_AVATARS.length);

/** Static CSS — does not depend on message content. */
const skeletonCSS = `
@keyframes sk-typing {
  from { width: 0; }
  to { width: 100%; }
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
 * First cycle: a static message fades into a typewriter message.
 * Subsequent cycles: continuous typewriter — each new message types out
 * immediately after the previous one blinks for 3s.
 *
 * Cycling is started here and cancelled by hideAppSkeleton$ via resetSignal.
 */
export function AppSkeleton({ visible = true }: { visible?: boolean }) {
  const { staticMsg, typewriterMsg, isFirst, cycle } =
    useGet(skeletonMessages$);
  const charCount = typewriterMsg.length;

  return (
    <div
      data-testid="app-skeleton"
      aria-hidden={visible ? undefined : true}
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
        <div key={cycle} className="relative h-6">
          {/* Invisible spacer — sizes container to typewriter text width */}
          <p
            className="invisible text-base font-medium whitespace-nowrap"
            aria-hidden="true"
          >
            {typewriterMsg}
          </p>
          {/* Static message: only shown on first cycle */}
          {isFirst && (
            <p
              className="absolute top-0 left-1/2 -translate-x-1/2 text-base font-medium text-foreground/70 whitespace-nowrap"
              style={{
                animation: "sk-hide-static 800ms forwards",
              }}
            >
              {staticMsg}
            </p>
          )}
          {/* Typewriter: delayed 800ms on first cycle, immediate on subsequent */}
          <p
            className="absolute inset-0 text-base font-medium text-foreground/70 overflow-hidden whitespace-nowrap border-r-2 border-current"
            style={{
              visibility: "hidden",
              width: 0,
              animation: isFirst
                ? `sk-show-typewriter 800ms forwards, sk-typing 1.5s steps(${charCount}) 800ms forwards, sk-blink 0.6s step-end 800ms infinite`
                : `sk-show-typewriter 0s forwards, sk-typing 1.5s steps(${charCount}) forwards, sk-blink 0.6s step-end infinite`,
            }}
          >
            {typewriterMsg}
          </p>
        </div>
      </div>
    </div>
  );
}
