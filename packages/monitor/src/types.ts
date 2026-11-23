// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

export type MonitorFormat = 'text' | 'ansi' | 'markdown' | 'json';
export type ChatRenderer = 'auto' | 'plain' | 'katex';

/** Capability evidence belongs to a specific delivery surface, not an agent or MCP server name. */
export interface MonitorCapabilityProfile {
  renderer: 'katex';
  version: string;
  surface: 'assistant-markdown' | 'tool-result' | 'notification';
  qualified: boolean;
  subset: 'graphloom-v1';
  maxBytes?: number;
  maxMathBytes?: number;
  maxColumns?: number;
}

export interface RenderOptions {
  format?: MonitorFormat;
  width?: number;
  chatRenderer?: ChatRenderer;
  noColor?: boolean;
  maxBytes?: number;
  capabilityProfile?: MonitorCapabilityProfile;
}

export interface RenderedReport {
  frameId: string;
  format: MonitorFormat;
  requestedRenderer: ChatRenderer;
  usedRenderer: 'plain' | 'ansi' | 'json' | 'katex' | 'hybrid';
  fallbackReasons: string[];
  output: string;
  truncated: boolean;
  continuation: string[];
}
