import type { Db } from '../../src/types.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import { IngestQueue } from '../../src/ingest/queue.js';
import { SessionListener } from '../../src/dsh/session-listener.js';
import {
  emptyMemoryVisibility, foldMemoryVisibility, visibleMemoryRefs, type MemoryVisibilityState,
} from '../../src/dsh/memory-visibility.js';

export function visibilityHarness(db: Db, cfg: PluginConfig = DEFAULTS) {
  const queue = new IngestQueue(db, cfg);
  const listener = new SessionListener(queue, cfg);
  const states = new Map<string, MemoryVisibilityState>();
  return {
    getVisibleRefs: (session: any) => visibleMemoryRefs(states.get(session.id) || emptyMemoryVisibility()),
    async commitEvent(session: any, event: any) {
      states.set(session.id, foldMemoryVisibility(states.get(session.id) || emptyMemoryVisibility(), event));
      listener.handleEvent(session, event);
      await queue.flush();
    },
    close: () => queue.close(),
  };
}
