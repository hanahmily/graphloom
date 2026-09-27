import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  const response = request.input?.reply ?? process.env.TEST_EXECUTOR_REPLY ?? "null";
  process.stdout.write(`${response}\n`);
}
