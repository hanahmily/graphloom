// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The version the real `hello` example bundle declares, read from its manifest so tests never hard-code it. */
export const HELLO_VERSION: string = (JSON.parse(readFileSync(path.join(root, "examples/plugins/hello/graphloom.manifest.json"), "utf8")) as { version: string }).version;

/** The active-version label for the real `hello` bundle. */
export const HELLO_ACTIVE_VERSION = `hello@${HELLO_VERSION}`;
