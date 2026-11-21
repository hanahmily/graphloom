// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { hubPaths } from "./hub-config.js";

export class HubHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "HubHttpError"; }
}

/** Local owner-only transport. Never falls back to a TCP endpoint. */
export async function hubRequest<T>(method: string, route: string, body?: unknown, socket = hubPaths().socket): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    const req = request({ socketPath: socket, path: route, method, headers: { "content-type": "application/json", ...(payload !== undefined ? { "content-length": Buffer.byteLength(payload) } : {}) } }, (response) => {
      void readJson(response).then((value) => {
        const status = response.statusCode ?? 500;
        if (status >= 400) reject(new HubHttpError((value as { error?: string }).error ?? `hub returned ${status}`, status));
        else resolve(value as T);
      }, reject);
    });
    req.setTimeout(30_000, () => req.destroy(new Error("hub request timed out; retry mutations with the same command/idempotency key")));
    req.on("error", (error) => reject(new Error(`cannot reach hub at ${socket}: ${error.message}`)));
    req.end(payload);
  });
}

export async function readJson(stream: IncomingMessage, limit = 16 * 1024 * 1024): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > limit) throw new HubHttpError("hub message exceeds its size limit", 413);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text) as unknown; }
  catch { throw new HubHttpError("invalid JSON in hub message", 400); }
}
