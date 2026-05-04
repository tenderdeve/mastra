import { test, expect } from '@playwright/test';
import { resetStorage } from '../../../__utils__/reset-storage';

const PORT = process.env.E2E_PORT || '4111';
const BASE_URL = `http://localhost:${PORT}`;

type PromptBlockResponse = {
  id: string;
};

type PromptBlockVersion = {
  id: string;
  versionNumber: number;
};

type PromptBlockVersionsResponse = {
  versions: PromptBlockVersion[];
};

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

async function createPromptBlockVersions() {
  const blockId = `version-switch-${Date.now().toString(36)}`;

  const created = await apiRequest<PromptBlockResponse>('/stored/prompt-blocks', {
    method: 'POST',
    body: JSON.stringify({
      id: blockId,
      name: 'Version Switch Prompt',
      description: 'Original prompt description',
      content: 'Original prompt content',
    }),
  });

  await apiRequest<PromptBlockResponse>(`/stored/prompt-blocks/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: 'Version Switch Prompt',
      description: 'Latest prompt description',
      content: 'Latest prompt content',
    }),
  });

  const { versions } = await apiRequest<PromptBlockVersionsResponse>(
    `/stored/prompt-blocks/${created.id}/versions?sortDirection=DESC`,
  );

  const originalVersion = versions.find(version => version.versionNumber === 1);
  if (!originalVersion) {
    throw new Error('Could not find original prompt block version');
  }

  return { blockId: created.id, originalVersion };
}

test.afterEach(async () => {
  await resetStorage();
});

test.describe('Prompt Block Version Editing', () => {
  test('shows selected version content in the editor and sidebar', async ({ page }) => {
    /**
     * FEATURE: Prompt block version browsing.
     * USER STORY: As a Studio user, I want selecting an older prompt block version to show that version's saved data.
     * BEHAVIOR UNDER TEST: Version selection changes both the main editor content and sidebar description values.
     */
    const { blockId, originalVersion } = await createPromptBlockVersions();

    await page.goto(`/cms/prompts/${blockId}/edit`);

    await expect(page.locator('#prompt-block-description')).toHaveValue('Latest prompt description');
    await expect(page.locator('.cm-content')).toContainText('Latest prompt content');

    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: /v1/ }).click();

    await expect(page).toHaveURL(new RegExp(`/cms/prompts/${blockId}/edit\\?versionId=${originalVersion.id}`));
    await expect(page.getByText('This is a previous version')).toBeVisible();
    await expect(page.locator('#prompt-block-description')).toHaveValue('Original prompt description');
    await expect(page.locator('.cm-content')).toContainText('Original prompt content');
    await expect(page.locator('.cm-content')).not.toContainText('Latest prompt content');

    await page.reload();

    await expect(page.locator('#prompt-block-description')).toHaveValue('Original prompt description');
    await expect(page.locator('.cm-content')).toContainText('Original prompt content');
  });
});
