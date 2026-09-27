import type { PluginHost } from "@graphloom/plugin-host";

export interface ActiveSession {
  runId: string;
  stateDir: string;
  host: PluginHost;
  stopRequested: boolean;
}

/** In-memory map of running controller sessions (for Stop to reap children). */
const sessions = new Map<string, ActiveSession>();

// Keep the owner alive until its loop has aborted and reaped executor children.
// Install only while sessions exist; repeated termination signals remain cooperative.
function requestTermination(): void {
  for (const session of new Set(sessions.values())) session.stopRequested = true;
}

export function registerSession(session: ActiveSession): void {
  if (sessions.size === 0) process.on("SIGTERM", requestTermination);
  sessions.set(session.stateDir, session);
  sessions.set(session.runId, session);
}

export function getSession(key: string): ActiveSession | undefined {
  return sessions.get(key);
}

export function unregisterSession(session: ActiveSession): void {
  sessions.delete(session.stateDir);
  sessions.delete(session.runId);
  if (sessions.size === 0) process.removeListener("SIGTERM", requestTermination);
}

export async function reapSession(session: ActiveSession): Promise<void> {
  session.stopRequested = true;
  await session.host.close().catch(() => undefined);
  unregisterSession(session);
}
