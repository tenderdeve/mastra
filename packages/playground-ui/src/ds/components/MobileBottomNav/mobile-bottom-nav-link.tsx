import type { LinkComponent } from '@/ds/types/link-component';
import { cn } from '@/lib/utils';

export type MobileNavLink = {
  name: string;
  url: string;
  icon?: React.ReactNode;
};

export type MobileBottomNavLinkProps = {
  link: MobileNavLink;
  isActive?: boolean;
  LinkComponent: LinkComponent;
};

export function MobileBottomNavLink({ link, isActive, LinkComponent: Link }: MobileBottomNavLinkProps) {
  const isExternal = link.url.startsWith('http');
  const linkParams = isExternal ? { target: '_blank' as const, rel: 'noreferrer' } : {};

  return (
    <Link
      href={link.url}
      aria-current={isActive ? 'page' : undefined}
      {...linkParams}
      className={cn(
        'flex flex-col items-center justify-center gap-0.5 px-1 py-1.5 min-w-0 flex-1',
        'text-neutral3 transition-colors duration-normal',
        '[&_svg]:w-5 [&_svg]:h-5 [&_svg]:transition-colors [&_svg]:duration-normal',
        {
          'text-neutral5 [&_svg]:text-neutral5': isActive,
          '[&_svg]:text-neutral3/60': !isActive,
        },
      )}
    >
      {link.icon}
      <span className="text-[0.5625rem] leading-tight truncate w-full text-center">{link.name}</span>
    </Link>
  );
}
