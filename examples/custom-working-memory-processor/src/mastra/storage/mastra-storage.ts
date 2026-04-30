import { LibSQLStore } from '@mastra/libsql';

export const mastraStorage = new LibSQLStore({
  id: 'mastra-storage',
  url: 'file:./mastra.db',
});
