/**
 * Resolve MiniMax credentials for the Pi supervisor runtime.
 * Prefer explicit keys; never log or return values into prompts/transcripts.
 */

export type MiniMaxCredentialSource =
  | "options"
  | "env:MINIMAX_CN_API_KEY"
  | "env:MINIMAX_API_KEY"
  | "pi-stored";

export interface ResolvedMiniMaxCredential {
  /** Present only when GraphLoom injects the key into ModelRuntime. */
  apiKey?: string;
  source: MiniMaxCredentialSource;
}

/**
 * Credential resolution order for `minimax-cn`:
 * 1. explicit `apiKey` option
 * 2. `MINIMAX_CN_API_KEY`
 * 3. `MINIMAX_API_KEY`
 * 4. Pi-stored credential under agentDir (command reference or saved key)
 */
export function resolveMiniMaxCredential(options?: {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedMiniMaxCredential {
  const env = options?.env ?? process.env;
  const explicit = options?.apiKey?.trim();
  if (explicit) {
    return { apiKey: explicit, source: "options" };
  }
  const cn = env.MINIMAX_CN_API_KEY?.trim();
  if (cn) {
    return { apiKey: cn, source: "env:MINIMAX_CN_API_KEY" };
  }
  const general = env.MINIMAX_API_KEY?.trim();
  if (general) {
    return { apiKey: general, source: "env:MINIMAX_API_KEY" };
  }
  return { source: "pi-stored" };
}
