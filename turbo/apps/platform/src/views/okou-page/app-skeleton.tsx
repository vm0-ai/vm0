import { AvatarSvgPreview } from "./avatar-svg-preview.tsx";
import { getAvatarPresets } from "./avatars.ts";

const firstAvatarPreset = getAvatarPresets()[0]!;

export function AppSkeleton({
  onHidden,
  visible = true,
}: {
  onHidden?: () => void;
  visible?: boolean;
}) {
  return (
    <div
      data-testid="app-skeleton"
      aria-hidden={visible ? undefined : true}
      aria-label="Loading"
      aria-live="polite"
      role="status"
      onTransitionEnd={(event) => {
        if (!visible && event.target === event.currentTarget) {
          onHidden?.();
        }
      }}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-background ${
        visible
          ? "opacity-100"
          : "opacity-0 pointer-events-none transition-opacity duration-300"
      }`}
    >
      <AvatarSvgPreview
        config={firstAvatarPreset}
        size={64}
        className="animate-pulse rounded-full"
      />
    </div>
  );
}
