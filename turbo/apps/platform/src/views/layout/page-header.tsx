interface PageHeaderProps {
  title: string;
  subtitle?: string;
}

export function PageHeader({ title, subtitle }: PageHeaderProps) {
  return (
    <div className="px-4 sm:px-8 pt-6 sm:pt-8 pb-4 sm:pb-5">
      <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-1 text-sm sm:text-base text-muted-foreground">
          {subtitle}
        </p>
      )}
    </div>
  );
}
