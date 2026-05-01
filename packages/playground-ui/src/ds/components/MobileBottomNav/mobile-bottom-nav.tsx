import { MobileBottomNavLink } from './mobile-bottom-nav-link';
import { MobileBottomNavRoot } from './mobile-bottom-nav-root';

export type { MobileNavLink } from './mobile-bottom-nav-link';

export const MobileBottomNav = Object.assign(MobileBottomNavRoot, {
  Link: MobileBottomNavLink,
});
