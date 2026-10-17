import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSupervisorSession, supervisorSessionModel } from "./pi-session.js";

const temps: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

interface AnthropicRequest {
  messages: Array<{ role: string; content: string | Array<{ type: string; thinking?: string; text?: string; signature?: string }> }>;
}

/**
 * An Anthropic-compatible endpoint that answers like MiniMax: a thinking block
 * whose signature is empty, then text. It records every request body.
 */
async function minimaxLikeServer(): Promise<{ baseUrl: string; requests: AnthropicRequest[] }> {
  const requests: AnthropicRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(body) as AnthropicRequest);
      const events: Array<[string, unknown]> = [
        ["message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: "sig-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private plan: record_finding then reenter" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "visible answer" } }],
        ["content_block_stop", { type: "content_block_stop", index: 1 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } }],
        ["message_stop", { type: "message_stop" }],
      ];
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

async function agentDirFor(baseUrl: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-sig-"));
  temps.push(dir);
  const model = {
    id: "sig-test",
    name: "sig-test",
    api: "anthropic-messages",
    baseUrl,
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  await writeFile(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        "minimax-cn": { models: [model] },
        "plain-anthropic": { baseUrl, api: "anthropic-messages", apiKey: "test-key", models: [model] },
      },
    }),
    "utf8",
  );
  return dir;
}

/** The assistant turn the second request replays from the first reply. */
function replayedAssistant(requests: AnthropicRequest[]): Array<{ type: string; thinking?: string; text?: string; signature?: string }> {
  expect(requests).toHaveLength(2);
  const assistant = requests[1]!.messages.find((m) => m.role === "assistant");
  expect(assistant).toBeDefined();
  return typeof assistant!.content === "string" ? [{ type: "text", text: assistant!.content }] : assistant!.content;
}

describe("Pi supervisor session: empty-signature thinking", () => {
  it("replays a minimax-cn thinking block with an empty signature as thinking, not as text it said", async () => {
    const server = await minimaxLikeServer();
    const agentDir = await agentDirFor(server.baseUrl);
    const session = await createPiSupervisorSession({
      runId: "run-sig",
      sessionDir: path.join(agentDir, "sessions"),
      agentDir,
      cwd: agentDir,
      provider: "minimax-cn",
      modelId: "sig-test",
      apiKey: "test-key",
      thinkingLevel: "high",
    });
    try {
      expect(await session.prompt("first")).toBe("visible answer");
      await session.prompt("second");
      const blocks = replayedAssistant(server.requests);
      expect(blocks).toContainEqual({ type: "thinking", thinking: "private plan: record_finding then reenter", signature: "" });
      expect(blocks.filter((b) => b.type === "text").map((b) => b.text)).toEqual(["visible answer"]);
    } finally {
      await session.close();
    }
  });

  it("applies the same compat after a model switch to minimax-cn", async () => {
    const server = await minimaxLikeServer();
    const agentDir = await agentDirFor(server.baseUrl);
    const session = await createPiSupervisorSession({
      runId: "run-sig-switch",
      sessionDir: path.join(agentDir, "sessions"),
      agentDir,
      cwd: agentDir,
      provider: "plain-anthropic",
      modelId: "sig-test",
      thinkingLevel: "high",
    });
    const savedKey = process.env.MINIMAX_CN_API_KEY;
    process.env.MINIMAX_CN_API_KEY = "test-key";
    try {
      await session.setModel({ provider: "minimax-cn", modelId: "sig-test", thinkingLevel: "high" });
      await session.prompt("first");
      await session.prompt("second");
      expect(replayedAssistant(server.requests)).toContainEqual(expect.objectContaining({ type: "thinking", signature: "" }));
    } finally {
      if (savedKey === undefined) delete process.env.MINIMAX_CN_API_KEY;
      else process.env.MINIMAX_CN_API_KEY = savedKey;
      await session.close();
    }
  });

  it("leaves other providers on Pi's default, which replays such a block as text", async () => {
    const server = await minimaxLikeServer();
    const agentDir = await agentDirFor(server.baseUrl);
    const session = await createPiSupervisorSession({
      runId: "run-sig-plain",
      sessionDir: path.join(agentDir, "sessions"),
      agentDir,
      cwd: agentDir,
      provider: "plain-anthropic",
      modelId: "sig-test",
      thinkingLevel: "high",
    });
    try {
      await session.prompt("first");
      await session.prompt("second");
      const blocks = replayedAssistant(server.requests);
      expect(blocks.some((b) => b.type === "thinking")).toBe(false);
      expect(blocks).toContainEqual(expect.objectContaining({ type: "text", text: "private plan: record_finding then reenter" }));
    } finally {
      await session.close();
    }
  });

  it("copies the registry model instead of mutating it", () => {
    const registered = { provider: "minimax-cn", id: "MiniMax-M3", compat: { supportsStrictTools: false } };
    const model = supervisorSessionModel(registered as never) as unknown as typeof registered & { compat: Record<string, unknown> };
    expect(model).not.toBe(registered);
    expect(model.compat).toEqual({ supportsStrictTools: false, allowEmptySignature: true });
    expect(registered.compat).toEqual({ supportsStrictTools: false });
    const other = { provider: "anthropic", id: "x" };
    expect(supervisorSessionModel(other as never)).toBe(other);
  });
});
