import type { ReactNode } from 'react';
import type { LinkComponent } from '@/ds/types/link-component';
import { cn } from '@/lib/utils';

export type EntityCardRootProps = {
  children: ReactNode;
  className?: string;
};

export function EntityCardRoot({ children, className }: EntityCardRootProps) {
  return <div className={cn('flex flex-col gap-3', className)}>{children}</div>;
}

export type EntityCardLinkProps = {
  children: ReactNode;
  to: string;
  className?: string;
  LinkComponent: LinkComponent;
};

export function EntityCardLink({ children, to, className, LinkComponent: Link }: EntityCardLinkProps) {
  return (
    <Link
      href={to}
      className={cn(
        'flex flex-col gap-2 p-4 rounded-xl bg-surface2 border border-border1',
        'hover:bg-surface3 active:bg-surface4 transition-colors duration-200',
        className,
      )}
    >
      {children}
    </Link>
  );
}

export type EntityCardTitleProps = {
  children: ReactNode;
  className?: string;
};

export function EntityCardTitle({ children, className }: EntityCardTitleProps) {
  return <span className={cn('text-ui-md font-medium text-neutral5 truncate', className)}>{children}</span>;
}

export type EntityCardDescriptionProps = {
  children: ReactNode;
  className?: string;
};

export function EntityCardDescription({ children, className }: EntityCardDescriptionProps) {
  return <span className={cn('text-ui-sm text-neutral2 line-clamp-2', className)}>{children}</span>;
}

export type EntityCardMetaProps = {
  children: ReactNode;
  className?: string;
};

export function EntityCardMeta({ children, className }: EntityCardMetaProps) {
  return <div className={cn('flex items-center gap-3 text-ui-xs text-neutral3', className)}>{children}</div>;
}

export type EntityCardMetaItemProps = {
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function EntityCardMetaItem({ icon, children, className }: EntityCardMetaItemProps) {
  return (
    <span className={cn('flex items-center gap-1 [&_svg]:w-3.5 [&_svg]:h-3.5', className)}>
      {icon}
      {children}
    </span>
  );
}

export type EntityCardSkeletonProps = {
  count?: number;
  className?: string;
};

export function EntityCardSkeleton({ count = 3, className }: EntityCardSkeletonProps) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2 p-4 rounded-xl bg-surface2 border border-border1 animate-pulse">
          <div className="h-4 w-1/3 bg-surface4 rounded" />
          <div className="h-3 w-2/3 bg-surface4 rounded" />
          <div className="flex gap-3 mt-1">
            <div className="h-3 w-16 bg-surface4 rounded" />
            <div className="h-3 w-10 bg-surface4 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export const EntityCard = Object.assign(EntityCardRoot, {
  Link: EntityCardLink,
  Title: EntityCardTitle,
  Description: EntityCardDescription,
  Meta: EntityCardMeta,
  MetaItem: EntityCardMetaItem,
  Skeleton: EntityCardSkeleton,
});
