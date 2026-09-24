import type { PluginHost } from "@graphloom/plugin-host";

export interface ActiveSession {
  runId: string;
  stateDir: string;
  host: PluginHost;
  stopRequested: boolean;
}

/** In-memory map of running controller sessions (for Stop to reap children). */
const sessions = new Map<string, ActiveSession>();

export function registerSession(session: ActiveSession): void {
  sessions.set(session.stateDir, session);
  sessions.set(session.runId, session);
}

export function getSession(key: string): ActiveSession | undefined {
  return sessions.get(key);
}

export function unregisterSession(session: ActiveSession): void {
  sessions.delete(session.stateDir);
  sessions.delete(session.runId);
}

export async function reapSession(session: ActiveSession): Promise<void> {
  session.stopRequested = true;
  await session.host.close().catch(() => undefined);
  unregisterSession(session);
}
