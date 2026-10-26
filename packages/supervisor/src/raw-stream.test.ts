// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSupervisorSession } from "./pi-session.js";
import { captureRawStream, summarize, type RawStreamRecord } from "./raw-stream.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const temps: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** A reply like the dogfood failure: thinking, then output in a block type Pi does not parse, then end_turn. */
const REPLY = sse([
  { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "raw-model", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I can call both in one block." } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "vendor_tool_call", name: "reenter" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } },
  { type: "message_stop" },
]);

async function provider(): Promise<{ baseUrl: string; requests: Array<{ headers: IncomingMessage["headers"]; body: string }> }> {
  const requests: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(REPLY);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function session(rawStreamCapture: boolean) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-raw-stream-"));
  temps.push(dir);
  const { baseUrl, requests } = await provider();
  const agentDir = path.join(dir, "agent");
  await import("node:fs/promises").then((fs) => fs.mkdir(agentDir, { recursive: true }));
  await writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "raw-test": {
          baseUrl,
          apiKey: "secret-test-key",
          models: [{ id: "raw-model", name: "raw-model", api: "anthropic-messages", reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    }),
  );
  const sessionDir = path.join(dir, "supervisor");
  const s = await createPiSupervisorSession({ sessionDir, agentDir, provider: "raw-test", modelId: "raw-model", runId: "raw", rawStreamCapture, promptTimeoutMs: 5_000 });
  return { s, sessionDir, requests };
}

describe("raw stream capture", () => {
  it("records the raw response, including a block type Pi drops, without request headers", async () => {
    const { s, sessionDir, requests } = await session(true);
    try {
      await s.prompt("decide").catch(() => undefined);
    } finally {
      await s.close();
    }
    expect(requests).toHaveLength(1);
    const rawDir = path.join(sessionDir, "raw");
    // The log is written once the copy of the stream has been read to the end.
    let lines: string[] = [];
    for (let i = 0; i < 50 && lines.length === 0; i++) {
      const files = await readdir(rawDir).catch(() => [] as string[]);
      lines = files.length === 0 ? [] : (await readFile(path.join(rawDir, files[0]!), "utf8")).trim().split("\n").filter(Boolean);
      if (lines.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as RawStreamRecord;
    expect(record.status).toBe(200);
    expect(record.blockTypes).toEqual(["thinking", "vendor_tool_call"]);
    expect(record.unknownBlockTypes).toEqual(["vendor_tool_call"]);
    expect(record.stopReasons).toEqual(["end_turn"]);
    expect(record.body).toBe(REPLY);
    expect((record.request as { model?: string }).model).toBe("raw-model");
    // Credentials travel in headers, which are never written.
    expect(lines[0]).not.toContain("secret-test-key");
  });

  it("writes nothing unless enabled", async () => {
    const { s, sessionDir } = await session(false);
    try {
      await s.prompt("decide").catch(() => undefined);
    } finally {
      await s.close();
    }
    await new Promise((r) => setTimeout(r, 100));
    await expect(readdir(path.join(sessionDir, "raw"))).rejects.toThrow();
  });
});

describe("summarize", () => {
  it("lists block types and stop reasons from an SSE body", () => {
    expect(summarize(REPLY)).toEqual({ blockTypes: ["thinking", "vendor_tool_call"], unknownBlockTypes: ["vendor_tool_call"], stopReasons: ["end_turn"] });
  });
});

/** A stand-in session: its agent's stream function records the options it was called with. */
function fakeSession(calls: Array<Record<string, unknown> | undefined>): AgentSession {
  return {
    sessionId: "fake",
    agent: { streamFunction: (_m: unknown, _c: unknown, o?: Record<string, unknown>) => (calls.push(o), "stream") },
  } as unknown as AgentSession;
}

async function readLines(file: string): Promise<string[]> {
  for (let i = 0; i < 50; i++) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.trim() !== "") return text.trim().split("\n");
    await new Promise((r) => setTimeout(r, 20));
  }
  return [];
}

describe("captureRawStream", () => {
  it("leaves requests of APIs that reject a custom fetch untouched, and says so once", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-raw-unsupported-"));
    temps.push(dir);
    const calls: Array<Record<string, unknown> | undefined> = [];
    const session = fakeSession(calls);
    captureRawStream(session, dir);
    const stream = (session as unknown as { agent: { streamFunction: (m: unknown, c: unknown, o?: Record<string, unknown>) => unknown } }).agent.streamFunction;
    stream({ api: "google-generative-ai" }, {}, { timeoutMs: 1 });
    stream({ api: "google-generative-ai" }, {}, { timeoutMs: 1 });
    stream({ api: "anthropic-messages" }, {}, { timeoutMs: 1 });
    expect(calls[0]).toEqual({ timeoutMs: 1 });
    expect(calls[1]).toEqual({ timeoutMs: 1 });
    expect(typeof calls[2]?.fetch).toBe("function");
    expect(calls[2]?.transport).toBeUndefined();
    stream({ api: "openai-codex-responses" }, {}, { transport: "auto" });
    expect(calls[3]?.transport).toBe("sse");
    expect(typeof calls[3]?.fetch).toBe("function");
    const lines = await readLines(path.join(dir, "fake.raw.jsonl"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).note).toMatch(/not supported for api google-generative-ai/);
  });

  it("keeps the bytes that arrived when a response breaks off part-way", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-raw-partial-"));
    temps.push(dir);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {}\n\n");
      setTimeout(() => res.socket?.destroy(), 20);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
    const calls: Array<Record<string, unknown> | undefined> = [];
    const session = fakeSession(calls);
    captureRawStream(session, dir);
    (session as unknown as { agent: { streamFunction: (m: unknown, c: unknown, o?: Record<string, unknown>) => unknown } }).agent.streamFunction({ api: "anthropic-messages" }, {}, {});
    const capturing = calls[0]!.fetch as typeof fetch;
    const response = await capturing(url, { method: "POST", body: JSON.stringify({ model: "m" }) });
    await response.text().catch(() => undefined);
    const lines = await readLines(path.join(dir, "fake.raw.jsonl"));
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as RawStreamRecord;
    expect(record.body).toBe("event: message_start\ndata: {}\n\n");
    expect(record.readError).toBeTruthy();
  });
});

