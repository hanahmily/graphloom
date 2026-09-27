// The Pi harness on a faux provider, for the executor process in e2e tests.
// Each job scripts its provider replies in `harnessOptions.faux`:
// `{ tool, args }` requests a tool call, `{ text }` replies and ends the turn.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiHarness } from "@graphloom/executor-coding-agent/pi";

function findPackageDir(fromFile, pkg) {
  for (const dir of createRequire(fromFile).resolve.paths(pkg) ?? []) {
    const candidate = path.join(dir, pkg);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`${pkg} not found from ${fromFile}`);
}

const piDir = findPackageDir(import.meta.filename, "@earendil-works/pi-coding-agent");
const aiDir = findPackageDir(path.join(piDir, "package.json"), "@earendil-works/pi-ai");
const ai = await import(pathToFileURL(path.join(aiDir, "dist", "index.js")).href);

const faux = ai.fauxProvider({ provider: "faux-e2e" });
const pi = createPiHarness({
  provider: "faux-e2e",
  modelId: faux.getModel().id,
  async createModelRuntime(agentDir) {
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
    });
    runtime.registerNativeProvider(faux.provider);
    return runtime;
  },
});

export const harness = {
  name: pi.name,
  resumable: pi.resumable,
  async createSession(options) {
    faux.setResponses(
      (options.options?.faux ?? []).map((step) =>
        step.tool !== undefined
          ? ai.fauxAssistantMessage(ai.fauxToolCall(step.tool, step.args ?? {}), { stopReason: "toolUse" })
          : ai.fauxAssistantMessage(step.text),
      ),
    );
    return pi.createSession(options);
  },
};
