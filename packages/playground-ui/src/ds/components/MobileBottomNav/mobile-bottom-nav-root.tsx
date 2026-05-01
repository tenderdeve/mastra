import { cn } from '@/lib/utils';

export type MobileBottomNavRootProps = {
  children: React.ReactNode;
  className?: string;
};

export function MobileBottomNavRoot({ children, className }: MobileBottomNavRootProps) {
  return (
    <nav
      aria-label="Main"
      className={cn(
        'fixed bottom-0 left-0 right-0 z-50 md:hidden',
        'flex items-stretch justify-around',
        'bg-surface1 border-t border-border1',
        'px-1 pb-[env(safe-area-inset-bottom)]',
        className,
      )}
    >
      {children}
    </nav>
  );
}
