import { test, expect } from '@playwright/test';
import { resetStorage } from '../__utils__/reset-storage';

const OBSERVABILITY_FILTERS_STORAGE_KEY = 'mastra:observability:saved-filters';

test.afterEach(async ({ page }) => {
  await page.evaluate(key => localStorage.removeItem(key), OBSERVABILITY_FILTERS_STORAGE_KEY).catch(() => undefined);
  await resetStorage();
});

/**
 * FEATURE: Observability filter persistence
 * USER STORY: As a user, I want saved filters to follow me between Metrics, Traces, and Logs so I can keep investigating the same slice of data.
 * BEHAVIOR UNDER TEST: A filter saved in localStorage hydrates clean observability URLs across tabs without requiring users to re-enter filters.
 */
test('saved observability filters hydrate metrics, traces, and logs pages', async ({ page }) => {
  await page.goto('/metrics');
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, value),
    [OBSERVABILITY_FILTERS_STORAGE_KEY, 'filterEnvironment=production&filterEntityName=Observer'],
  );

  await page.goto('/metrics');
  await expect(page).toHaveURL(/filterEnvironment=production/);
  await expect(page).toHaveURL(/filterEntityName=Observer/);

  await page.goto('/observability');
  await expect(page).toHaveURL(/filterEnvironment=production/);
  await expect(page).toHaveURL(/filterEntityName=Observer/);

  await page.goto('/logs');
  await expect(page).toHaveURL(/filterEnvironment=production/);
  await expect(page).toHaveURL(/filterEntityName=Observer/);
});
