import { cn } from '../../lib/utils';

export function Badge({ className, ...props }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-full border border-border bg-secondary/70 px-2.5 text-xs font-medium text-secondary-foreground',
        className,
      )}
      {...props}
    />
  );
}
