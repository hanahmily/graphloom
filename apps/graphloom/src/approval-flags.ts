// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import os from "node:os";
import type { ApprovalRequest } from "@graphloom/controller";

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

/** `--input <name>=<value>`, once for each value: the operator's input to an approval the graph declared (`inputs`), checked by the controller against the declaration. */
export function inputFlags(args: string[]): Record<string, string> | undefined {
  const inputs: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--input") continue;
    const text = args[i + 1];
    const eq = text === undefined ? -1 : text.indexOf("=");
    if (text === undefined || text.startsWith("--") || eq < 1) throw new Error("--input needs <name>=<value>");
    const name = text.slice(0, eq);
    if (Object.hasOwn(inputs, name)) throw new Error(`--input ${name} is given twice`);
    inputs[name] = text.slice(eq + 1);
    i += 1;
  }
  return Object.keys(inputs).length > 0 ? inputs : undefined;
}

/** `--approve <id> [--input <name>=<value> ...]`, or `--decline <id> [--reason <text>]` (docs/design-pr-review-graph.md section 11): who decides is the login running this. */
export function approvalFlags(args: string[], operator: string = os.userInfo().username): ApprovalRequest | undefined {
  const inputs = inputFlags(args);
  const approve = flagValue(args, "--approve");
  const decline = flagValue(args, "--decline");
  for (const flag of ["--approve", "--decline"]) {
    const value = flagValue(args, flag);
    if (args.includes(flag) && (value === undefined || value.startsWith("--") || value === "")) throw new Error(`${flag} needs an approval id`);
  }
  if (approve === undefined && decline === undefined) {
    if (inputs !== undefined) throw new Error("--input gives a value to --approve <id>");
    if (args.includes("--reason") && !args.includes("--supervisor")) throw new Error("--reason answers --supervisor or --decline");
    return undefined;
  }
  if (approve !== undefined && decline !== undefined) throw new Error("--approve and --decline decide one approval each; resume once for each");
  const reason = flagValue(args, "--reason");
  if (args.includes("--reason") && (reason === undefined || reason.startsWith("--"))) throw new Error("--reason needs a text");
  if (approve !== undefined && reason !== undefined) throw new Error("--reason goes with --decline");
  return {
    approvalId: (approve ?? decline)!,
    decision: approve !== undefined ? "approve" : "decline",
    ...(reason !== undefined ? { reason } : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    operator,
  };
}
