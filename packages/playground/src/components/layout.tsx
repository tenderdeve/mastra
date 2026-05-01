import { ErrorBoundary, MainSidebarProvider, ThemeProvider, Toaster, TooltipProvider } from '@mastra/playground-ui';
import { useLocation } from 'react-router';
import { AppMobileBottomNav } from './ui/app-mobile-bottom-nav';
import { AppSidebar } from './ui/app-sidebar';
import { AuthRequired } from '@/domains/auth/components/auth-required';
import { useAuthCapabilities } from '@/domains/auth/hooks/use-auth-capabilities';
import { isAuthenticated } from '@/domains/auth/types';
import { ExperimentalUIProvider } from '@/domains/experimental-ui/experimental-ui-context';
import { UI_EXPERIMENTS } from '@/domains/experimental-ui/experiments';
import { useExperimentalUIEnabled } from '@/domains/experimental-ui/use-experimental-ui-enabled';
import { NavigationCommand } from '@/lib/command';
import { cn } from '@/lib/utils';

function LayoutContent({ children }: { children: React.ReactNode }) {
  const { data: authCapabilities, isFetched } = useAuthCapabilities();
  const { pathname } = useLocation();
  const shouldHideSidebar = isFetched && authCapabilities?.enabled && !isAuthenticated(authCapabilities);
  const shouldShowSidebar = isFetched && !shouldHideSidebar;

  return (
    <>
      <NavigationCommand />
      <div className={shouldShowSidebar ? 'grid h-full grid-cols-1 md:grid-cols-[auto_1fr]' : 'h-full'}>
        {shouldShowSidebar && <AppSidebar />}
        <div
          className={cn('bg-transparent overflow-y-auto', {
            'h-[calc(100%-1.5rem)]': shouldHideSidebar,
            'pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0': shouldShowSidebar,
          })}
        >
          <AuthRequired>
            <ErrorBoundary resetKeys={[pathname]}>{children}</ErrorBoundary>
          </AuthRequired>
        </div>
      </div>
      {shouldShowSidebar && <AppMobileBottomNav />}
    </>
  );
}

export const Layout = ({ children }: { children: React.ReactNode }) => {
  const { experimentalUIEnabled } = useExperimentalUIEnabled();

  return (
    <div className="bg-surface1 font-sans h-screen">
      <Toaster position="bottom-right" />
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider delayDuration={0}>
          <ExperimentalUIProvider experiments={experimentalUIEnabled ? UI_EXPERIMENTS : []}>
            <MainSidebarProvider>
              <LayoutContent>{children}</LayoutContent>
            </MainSidebarProvider>
          </ExperimentalUIProvider>
        </TooltipProvider>
      </ThemeProvider>
    </div>
  );
};
