// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";

import { IntakeError, parseTaskYaml } from "./index.js";

/** The request a task file with this `request:` line reads as. */
const request = (line: string): string => parseTaskYaml(`graph: g\nrepo: r\n${line}\n`).request;

describe("task.yaml scalars are read as YAML reads them", () => {
  it("decodes a double-quoted request's escapes instead of keeping the backslashes", () => {
    expect(request(String.raw`request: "Create GREETING.txt with \"Hello, GraphLoom!\" in it"`)).toBe('Create GREETING.txt with "Hello, GraphLoom!" in it');
    expect(request(String.raw`request: "a\\b"`)).toBe("a\\b");
    expect(request(String.raw`request: "line one\nline two"`)).toBe("line one\nline two");
    expect(request(String.raw`request: "col\tcol"`)).toBe("col\tcol");
    expect(request(String.raw`request: "cr\r and slash \/"`)).toBe("cr\r and slash /");
    expect(request(String.raw`request: "\0\a\b\v\f\e\ end"`)).toBe("\0\x07\b\v\f\x1b end");
    expect(request(String.raw`request: "\N\_\L\P"`)).toBe("\u0085   ");
    expect(request(String.raw`request: "café \x41 \U0001F600"`)).toBe("café A \u{1F600}");
    expect(request(String.raw`request: "it's fine"`)).toBe("it's fine");
  });

  it("refuses a double-quoted scalar YAML would refuse", () => {
    for (const line of [
      String.raw`request: "unknown \q escape"`,
      String.raw`request: "short \u12 hex"`,
      String.raw`request: "bad \xZZ hex"`,
      String.raw`request: "out of range \UFFFFFFFF"`,
      String.raw`request: "lone backslash \"`,
      'request: "an "unescaped" quote"',
    ]) {
      expect(() => request(line), line).toThrow(IntakeError);
    }
  });

  it("reads '' in a single-quoted scalar as one quote and takes backslashes literally", () => {
    expect(request("request: 'it''s done'")).toBe("it's done");
    expect(request(String.raw`request: 'keep \n and \" as typed'`)).toBe(String.raw`keep \n and \" as typed`);
    expect(() => request("request: 'it's broken'")).toThrow(IntakeError);
  });

  it("takes plain and block scalars as written", () => {
    expect(request(String.raw`request: say \"hi\" plainly`)).toBe(String.raw`say \"hi\" plainly`);
    expect(request("request: |\n  Write \"Hello, GraphLoom!\" with a \\n in it.\n  Second line.")).toBe('Write "Hello, GraphLoom!" with a \\n in it.\nSecond line.');
  });

  it("reads the other keys' quoted values the same way", () => {
    const task = parseTaskYaml("graph: \"hello\"\nrepo: 'my ''repo'''\nbase: \"v1\\x2e0\"\nrequest: go\n");
    expect(task).toMatchObject({ graph: "hello", repo: "my 'repo'", base: "v1.0" });
  });
});
