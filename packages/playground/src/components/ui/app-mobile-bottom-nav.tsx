import { AgentIcon, MobileBottomNav, SettingsIcon, ToolsIcon, WorkflowIcon } from '@mastra/playground-ui';
import type { MobileNavLink } from '@mastra/playground-ui';
import { EyeIcon } from 'lucide-react';
import { useLocation } from 'react-router';
import { usePermissions } from '@/domains/auth/hooks/use-permissions';
import { useLinkComponent } from '@/lib/framework';

const mobileNavLinks: (MobileNavLink & { requiredPermission?: string; matchPaths?: string[] })[] = [
  {
    name: 'Agents',
    url: '/agents',
    icon: <AgentIcon />,
    requiredPermission: 'agents:read',
  },
  {
    name: 'Workflows',
    url: '/workflows',
    icon: <WorkflowIcon />,
    requiredPermission: 'workflows:read',
  },
  {
    name: 'Tools',
    url: '/tools',
    icon: <ToolsIcon />,
    requiredPermission: 'tools:read',
  },
  {
    name: 'Traces',
    url: '/observability',
    icon: <EyeIcon />,
    matchPaths: ['/observability', '/traces'],
    requiredPermission: 'observability:read',
  },
  {
    name: 'Settings',
    url: '/settings',
    icon: <SettingsIcon />,
  },
];

export function AppMobileBottomNav() {
  const { Link } = useLinkComponent();
  const { pathname } = useLocation();
  const { hasPermission, rbacEnabled } = usePermissions();

  const filteredLinks = mobileNavLinks.filter(link => {
    if (link.requiredPermission && rbacEnabled && !hasPermission(link.requiredPermission)) {
      return false;
    }
    return true;
  });

  return (
    <MobileBottomNav>
      {filteredLinks.map(link => {
        const paths = link.matchPaths ?? [link.url];
        const isActive = paths.some(p => pathname === p || pathname.startsWith(p + '/'));

        return <MobileBottomNav.Link key={link.url} link={link} isActive={isActive} LinkComponent={Link} />;
      })}
    </MobileBottomNav>
  );
}
