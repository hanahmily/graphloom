import { createPiHarness } from "./pi-harness.js";

export { createPiHarness, type PiHarnessOptions } from "./pi-harness.js";
export { PI_AGENT_DIR_ENV, PI_API_KEY_CREDENTIAL, PI_MODEL_ENV, PI_PROVIDER_ENV } from "./pi-config.js";

/** Default export for `GRAPHLOOM_CODING_HARNESS` pointing at this module; configured from the environment. */
export const harness = createPiHarness();
