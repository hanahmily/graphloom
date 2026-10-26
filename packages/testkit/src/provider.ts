// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestScope } from "./scope.js";

/**
 * One scripted provider fault, served for one request. Each is a reply
 * MiniMax actually sent a GraphLoom supervisor in a dogfood run:
 *
 * - `empty-signature-thinking`: a thinking block whose signature is empty,
 *   with a read-only tool call (`list_receipts`), so the turn continues and
 *   the next request replays the reply (#129: Pi replayed such a block as
 *   text the model said unless `allowEmptySignature` is set).
 * - `dropped-tool-call`: only thinking, `end_turn`, and usage billing
 *   `undeliveredTokens` output tokens beyond thinking that never arrived: the
 *   server dropped the tool call the model generated (#129).
 * - `http-error`: an HTTP error status with a provider error body: a 5xx
 *   (#139) or a 429 with no reset time.
 */
export type ProviderFault =
  | { kind: "empty-signature-thinking" }
  | { kind: "dropped-tool-call"; undeliveredTokens?: number }
  | { kind: "http-error"; status: number; body: string };

/** The 500 that stopped dogfood run cbef664d-c46 (#139). */
export const TRANSIENT_500_BODY = '{"type":"error","error":{"type":"api_error","message":"Internal server error. Please retry your request. (500)"}}';

/** MiniMax's usage-cap 429, which states no reset time. */
export const QUOTA_429_NO_RESET_BODY =
  '{"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"}}';

export const FAULTS = {
  emptySignatureThinking: { kind: "empty-signature-thinking" },
  droppedToolCall: { kind: "dropped-tool-call", undeliveredTokens: 576 },
  transient500: { kind: "http-error", status: 500, body: TRANSIENT_500_BODY },
  quota429NoReset: { kind: "http-error", status: 429, body: QUOTA_429_NO_RESET_BODY },
} as const satisfies Record<string, ProviderFault>;

/** A tool call the fake model makes once its scripted faults are spent. */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** A plain text answer instead (for a session that offers no tools). */
export interface TextReply {
  text: string;
}

export interface AnthropicRequest {
  model?: string;
  messages: Array<{ role: string; content: string | Array<Record<string, unknown> & { type: string }> }>;
  tools?: Array<{ name: string }>;
  [key: string]: unknown;
}

export interface FakeProviderOptions {
  /** Faults served in order, one per request, before the model decides normally. */
  faults?: ProviderFault[];
  /**
   * The decision the fake model makes once its faults are spent. Default:
   * the supervisor's `return` tool, handing control back to the graph.
   */
  decide?: (request: AnthropicRequest) => ToolCall | TextReply;
  /** Pi provider id the agent dir points at the fake. Default `minimax-cn`. */
  provider?: string;
  modelId?: string;
}

export interface FakeProvider {
  baseUrl: string;
  /** A Pi agent dir whose models.json and auth.json point `provider` at this server. */
  agentDir: string;
  provider: string;
  modelId: string;
  /** Every request body received, in order. */
  readonly requests: AnthropicRequest[];
  /** What each request was served: a fault kind, `decide:<tool>`, `text` or `refused:<violation>`. */
  readonly served: string[];
  /**
   * Requests that showed the client mishandled an earlier fault: thinking
   * replayed as text, or a dropped reply sent back to the model. Each was
   * refused with an HTTP 400 naming it, so the run cannot quietly carry on.
   */
  readonly violations: string[];
}

const DEFAULT_DECISION: ToolCall = { name: "return", input: { reason: "the failure was transient; hand control back to the graph", return: { summary: "retry" } } };

/**
 * A local endpoint speaking the Anthropic-messages SSE protocol MiniMax
 * serves, registered as a Pi provider (`minimax-cn` by default) in a
 * throwaway agent dir, so the real Pi session wrapper and supervisor run
 * against it unchanged. Closed on scope dispose.
 */
export async function startFakeProvider(scope: TestScope, options: FakeProviderOptions = {}): Promise<FakeProvider> {
  const provider = options.provider ?? "minimax-cn";
  const modelId = options.modelId ?? "MiniMax-M3";
  const faults = [...(options.faults ?? [])];
  const decide = options.decide ?? (() => DEFAULT_DECISION);
  const requests: AnthropicRequest[] = [];
  const served: string[] = [];
  const violations: string[] = [];
  /** Thinking text this fake sent, and what each must look like when the client replays it. */
  const thinkingSent: string[] = [];
  const droppedSent: string[] = [];
  let messageCount = 0;

  const serve = (req: IncomingMessage, res: ServerResponse, body: string) => {
    let request: AnthropicRequest;
    try {
      request = JSON.parse(body) as AnthropicRequest;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(errorBody("invalid_request_error", "testkit provider: request body is not JSON"));
      return;
    }
    requests.push(request);
    const violation = checkReplay(request, thinkingSent, droppedSent);
    if (violation !== undefined) {
      violations.push(violation);
      served.push(`refused:${violation}`);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(errorBody("invalid_request_error", `testkit provider: ${violation}`));
      return;
    }
    const n = ++messageCount;
    const fault = faults.shift();
    if (fault?.kind === "http-error") {
      served.push(`http-error:${fault.status}`);
      res.writeHead(fault.status, { "content-type": "application/json" });
      res.end(fault.body);
      return;
    }
    const sse = new Sse(res, `msg_testkit_${n}`, request.model ?? modelId);
    if (fault?.kind === "empty-signature-thinking") {
      const thinking = `testkit thinking ${n}: list the receipts, then decide.`;
      thinkingSent.push(thinking);
      served.push("empty-signature-thinking");
      sse.thinking(thinking, "");
      if (offered(request, "list_receipts")) {
        sse.toolUse({ name: "list_receipts", input: {} });
        sse.end("tool_use", 160, 40);
      } else {
        sse.reply(decide(request));
        sse.end("end_turn", 160, 40);
      }
      return;
    }
    if (fault?.kind === "dropped-tool-call") {
      const thinking = `testkit dropped reply ${n}: I will call the tool now.`;
      droppedSent.push(thinking);
      served.push("dropped-tool-call");
      sse.thinking(thinking, "");
      const thinkingTokens = 40;
      sse.end("end_turn", thinkingTokens + (fault.undeliveredTokens ?? 576), thinkingTokens);
      return;
    }
    const reply = decide(request);
    served.push("text" in reply ? "text" : `decide:${reply.name}`);
    sse.reply(reply);
    sse.end("text" in reply ? "end_turn" : "tool_use", 120);
  };

  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => serve(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  scope.defer(() => new Promise<void>((resolve) => server.close(() => resolve())));
  server.unref();
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const agentDir = path.join(await scope.tempDir("gl-fake-provider-"), "agent");
  await mkdir(agentDir, { recursive: true });
  const model = {
    id: modelId,
    name: modelId,
    api: "anthropic-messages",
    baseUrl,
    reasoning: true,
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [provider]: { baseUrl, api: "anthropic-messages", models: [model] } } }, null, 2));
  await writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ [provider]: { type: "api_key", key: "testkit-key" } }, null, 2), { mode: 0o600 });

  return { baseUrl, agentDir, provider, modelId, requests, served, violations };
}

function offered(request: AnthropicRequest, tool: string): boolean {
  return (request.tools ?? []).some((t) => t.name === tool);
}

function errorBody(type: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message } });
}

/**
 * Whether the request replays an earlier reply the way a correct client
 * must not: thinking sent back as text the model said, or a dropped reply
 * (one whose output never arrived) sent back to the model at all.
 */
function checkReplay(request: AnthropicRequest, thinkingSent: string[], droppedSent: string[]): string | undefined {
  for (const message of request.messages) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    for (const block of blocks) {
      const text = typeof block.text === "string" ? block.text : typeof block.thinking === "string" ? block.thinking : "";
      if (text === "") continue;
      if (droppedSent.some((t) => text.includes(t))) return "a reply whose output was dropped was sent back to the model";
      if (message.role === "assistant" && block.type === "text" && thinkingSent.some((t) => text.includes(t))) {
        return "an empty-signature thinking block was replayed as text the model said";
      }
    }
  }
  return undefined;
}

/** Writes one Anthropic-messages SSE reply. */
class Sse {
  private index = 0;

  constructor(
    private readonly res: ServerResponse,
    id: string,
    model: string,
  ) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    this.event("message_start", {
      type: "message_start",
      message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
    });
  }

  thinking(text: string, signature: string): void {
    const index = this.index++;
    this.event("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
    this.event("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } });
    if (signature !== "") this.event("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature } });
    this.event("content_block_stop", { type: "content_block_stop", index });
  }

  reply(reply: ToolCall | TextReply): void {
    if ("text" in reply) this.text(reply.text);
    else this.toolUse(reply);
  }

  text(text: string): void {
    const index = this.index++;
    this.event("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    this.event("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });
    this.event("content_block_stop", { type: "content_block_stop", index });
  }

  toolUse(call: ToolCall): void {
    const index = this.index++;
    this.event("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: `toolu_testkit_${index}_${Date.now()}`, name: call.name, input: {} },
    });
    this.event("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } });
    this.event("content_block_stop", { type: "content_block_stop", index });
  }

  end(stopReason: "tool_use" | "end_turn", outputTokens: number, thinkingTokens?: number): void {
    this.event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens, ...(thinkingTokens !== undefined ? { output_tokens_details: { thinking_tokens: thinkingTokens } } : {}) },
    });
    this.event("message_stop", { type: "message_stop" });
    this.res.end();
  }

  private event(name: string, data: unknown): void {
    this.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
