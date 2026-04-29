// Module-level cache that survives React component unmounts (e.g. when
// navigating to /admin and back). Lives as long as the JS module — does
// NOT survive a hard refresh, which is fine because File blobs can't be
// rehydrated from anywhere else either.
import type { PDFSession } from '@/types/utilscraper';

interface SessionsCache {
  sessions: PDFSession[];
  openTabs: string[];
  activeTabId: string | null;
  customFields: string[];
}

const cache: SessionsCache = {
  sessions: [],
  openTabs: [],
  activeTabId: null,
  customFields: [],
};

export const sessionsCache = {
  get sessions()      { return cache.sessions; },
  set sessions(v)     { cache.sessions = v; },
  get openTabs()      { return cache.openTabs; },
  set openTabs(v)     { cache.openTabs = v; },
  get activeTabId()   { return cache.activeTabId; },
  set activeTabId(v)  { cache.activeTabId = v; },
  get customFields()  { return cache.customFields; },
  set customFields(v) { cache.customFields = v; },
};
