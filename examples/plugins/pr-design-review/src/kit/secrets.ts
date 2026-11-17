// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "a private key header", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "a GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: "an AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "a Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
];

/** Where `text` holds something that looks like a credential (design §12.3), as `line N: a GitHub token`. */
export function secretFindings(text: string): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, i) => {
    for (const { name, re } of PATTERNS) if (re.test(line)) found.push(`line ${i + 1}: ${name}`);
  });
  return found;
}
