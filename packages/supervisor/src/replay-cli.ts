#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Opt-in live scoring: replays the committed episodes of run 9bfa446d-4ea
 * against a real provider and prints the score. Never run by CI.
 *
 *   GRAPHLOOM_REPLAY_LIVE=1 npm run replay:live -w @graphloom/supervisor -- \
 *     [--provider minimax-cn] [--model MiniMax-M3] [--fixtures <dir>]
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_FIXTURE_DIR, loadReplayFixtures, replayEpisodes } from "./episode-replay.js";
import { createPiSupervisorSession, DEFAULT_SUPERVISOR_MODEL, DEFAULT_SUPERVISOR_PROVIDER } from "./pi-session.js";
import { createPiSupervisor } from "./pi-supervisor.js";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.env.GRAPHLOOM_REPLAY_LIVE !== "1") {
    console.error("Live replay makes provider calls. Set GRAPHLOOM_REPLAY_LIVE=1 (and the provider's credentials) to run it.");
    process.exitCode = 2;
    return;
  }
  const provider = arg("provider") ?? DEFAULT_SUPERVISOR_PROVIDER;
  const modelId = arg("model") ?? DEFAULT_SUPERVISOR_MODEL;
  const { episodes, labels } = await loadReplayFixtures(arg("fixtures") ?? DEFAULT_FIXTURE_DIR);
  const dir = await mkdtemp(path.join(os.tmpdir(), "graphloom-replay-"));
  try {
    const score = await replayEpisodes({
      episodes,
      labels,
      timeoutMs: 300_000,
      createSupervisor: async (episode) =>
        createPiSupervisor({
          session: await createPiSupervisorSession({ runId: episode.runId, sessionDir: path.join(dir, episode.episodeId), provider, modelId }),
        }),
    });
    for (const r of score.results) {
      console.log(
        `${r.correct ? "ok  " : "MISS"} ${r.episodeId}: proposed ${r.proposed ?? "-"}, inadmissible ${r.inadmissible}, probes ${r.probes}, calls ${r.providerCalls}${r.error !== undefined ? `, error: ${r.error}` : ""}`,
      );
    }
    console.log(
      `${provider}/${modelId}: accuracy ${(score.accuracy * 100).toFixed(0)}% (${score.correct}/${score.episodes}), inadmissible stops ${score.inadmissibleStops}, ` +
        `inadmissible/episode ${score.inadmissiblePerEpisode.toFixed(2)}, probes/episode ${score.probesPerEpisode.toFixed(2)}, tokens/episode not reported by the session`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
