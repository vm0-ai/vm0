import noPermissionIllustration from "../assets/no-permission-illustration.webp";

type ZeroNoPermissionIllustrationProps = {
  className?: string;
};

/**
 * Padlock illustration for restricted access / not-found states (transparent WebP).
 */
export function ZeroNoPermissionIllustration({
  className = "h-28 w-auto max-w-[200px] object-contain opacity-90",
}: ZeroNoPermissionIllustrationProps) {
  return (
    <img
      src={noPermissionIllustration}
      alt=""
      role="presentation"
      loading="lazy"
      className={className}
    />
  );
}
