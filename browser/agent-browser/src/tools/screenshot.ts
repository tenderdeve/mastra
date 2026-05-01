/**
 * browser_screenshot - Capture a screenshot of the current page
 */

import { createTool } from '@mastra/core/tools';
import type { AgentBrowser } from '../agent-browser';
import { screenshotInputSchema } from '../schemas';
import { BROWSER_TOOLS } from './constants';

export function createScreenshotTool(browser: AgentBrowser) {
  return createTool({
    id: BROWSER_TOOLS.SCREENSHOT,
    description:
      'Capture a full-page screenshot as a visible PNG image. Use snapshot when you only need text or interactive elements — screenshots are expensive. Use this when you need to visually inspect the page, e.g. evaluating images, product photos, layout, design, or colors.',
    inputSchema: screenshotInputSchema,
    execute: async (input, { agent }) => {
      const threadId = agent?.threadId;
      browser.setCurrentThread(threadId);
      await browser.ensureReady();
      return await browser.screenshot(input, threadId);
    },
    toModelOutput(output) {
      const result = output as { base64: string; title?: string; url?: string };
      return {
        type: 'content' as const,
        value: [
          {
            type: 'media' as const,
            mediaType: 'image/png',
            data: result.base64,
          },
          ...(result.url
            ? [{ type: 'text' as const, text: `Screenshot of: ${result.title ?? result.url} (${result.url})` }]
            : []),
        ],
      };
    },
  });
}
