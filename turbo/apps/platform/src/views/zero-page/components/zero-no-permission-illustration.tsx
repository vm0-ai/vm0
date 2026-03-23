import noPermissionIllustration from "../assets/no-permission-illustration.png";

type ZeroNoPermissionIllustrationProps = {
  className?: string;
};

/**
 * Padlock illustration for restricted access / not-found states (transparent PNG).
 */
export function ZeroNoPermissionIllustration({
  className = "h-28 w-auto max-w-[200px] object-contain opacity-90",
}: ZeroNoPermissionIllustrationProps) {
  return (
    <img
      src={noPermissionIllustration}
      alt=""
      role="presentation"
      className={className}
    />
  );
}
