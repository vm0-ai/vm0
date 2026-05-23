interface SettingsSectionHeadingProps {
  title: string;
  description?: string;
}

export function SettingsSectionHeading({
  title,
  description,
}: SettingsSectionHeadingProps) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {description !== undefined && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
