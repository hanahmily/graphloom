/** Minimal env for plugin children — no inherited credentials or controller secrets. */
export function sanitizedPluginEnv(bundlePath: string): NodeJS.ProcessEnv {
  const allow = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    "NODE_OPTIONS",
    "NODE_PATH",
  ] as const;
  const env: NodeJS.ProcessEnv = {
    GRAPHLOOM_PLUGIN_CWD: bundlePath,
  };
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Keep npm workspace resolution for file: SDK deps without dumping full process.env.
  if (process.env.npm_config_user_agent) {
    env.npm_config_user_agent = process.env.npm_config_user_agent;
  }
  return env;
}
