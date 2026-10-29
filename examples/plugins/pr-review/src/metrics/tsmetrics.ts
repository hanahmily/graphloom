// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// tsmetrics: the TypeScript half of the code quality metrics
// (design-code-quality-metrics.md §2.1, §2.2, §3). It parses with the
// TypeScript compiler API only and never executes the measured code.

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { isGeneratedSource } from "./generated.js";
import { changedLines } from "./hunks.js";
import {
  SCHEMA,
  isTestPath,
  languageOf,
  type FileIndex,
  type FunctionIndexEntry,
  type Hunks,
  type MetricsDocument,
  type MetricsRecord,
  type Step,
} from "./record.js";
import { classifyFunction } from "./scope.js";

/** One function of a file, measured on its own. */
export interface MeasuredFunction {
  name: string;
  start: number;
  end: number;
  decisions: Step[];
  nestingPath: Step[];
}

interface Scope {
  name: string;
  closures: number;
  decisions: Step[];
  best: Step[];
  recorded: boolean;
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.body !== undefined
  );
}

function modulePathOf(file: string): string {
  return file.replace(/\.(d\.)?[cm]?[jt]sx?$/, "");
}

/** Measures every function of one TypeScript or JavaScript file. */
export function analyzeTypeScript(file: string, source: string): MeasuredFunction[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const mod = modulePathOf(file);
  const out: MeasuredFunction[] = [];
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const unwrap = (node: ts.Node): ts.Node => {
    let n = node;
    while (
      n.parent !== undefined &&
      (ts.isParenthesizedExpression(n.parent) ||
        ts.isAsExpression(n.parent) ||
        ts.isSatisfiesExpression(n.parent) ||
        ts.isNonNullExpression(n.parent))
    ) {
      n = n.parent;
    }
    return n;
  };

  const memberName = (name: ts.PropertyName | undefined): string | undefined => {
    if (name === undefined) return undefined;
    if (ts.isComputedPropertyName(name)) return `[${name.expression.getText(sf)}]`;
    return name.text;
  };

  /** The name of a function that is not inside another function. */
  const topLevelName = (node: FunctionLike, prefix: string[], glob: Scope): string => {
    const join = (last: string): string => [mod, ...prefix, last].join(".");
    if (ts.isFunctionDeclaration(node)) return join(node.name?.text ?? "default");
    if (ts.isConstructorDeclaration(node)) return join("constructor");
    if (ts.isMethodDeclaration(node)) return join(memberName(node.name) ?? "method");
    if (ts.isGetAccessorDeclaration(node)) return join(`get ${memberName(node.name) ?? ""}`);
    if (ts.isSetAccessorDeclaration(node)) return join(`set ${memberName(node.name) ?? ""}`);
    const parent = unwrap(node).parent;
    if (parent !== undefined) {
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return join(parent.name.text);
      if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
        const n = memberName(parent.name);
        if (n !== undefined) return join(n);
      }
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return join(parent.left.getText(sf));
      }
      if (ts.isExportAssignment(parent)) return join("default");
    }
    glob.closures++;
    return `${mod}.glob.func${glob.closures}`;
  };

  /** Start of a function's declaration, past decorators, so the line declares it. */
  const startOf = (node: FunctionLike): number => {
    const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
    if (decorators === undefined || decorators.length === 0) return node.getStart(sf);
    const first = ts.canHaveModifiers(node) ? ts.getModifiers(node)?.[0] : undefined;
    return (first ?? node.name ?? node).getStart(sf);
  };

  const scopeFor = (node: FunctionLike, enclosing: Scope, prefix: string[], glob: Scope): Scope => {
    let name: string;
    if (enclosing.recorded) {
      enclosing.closures++;
      name = `${enclosing.name}.func${enclosing.closures}`;
    } else {
      name = topLevelName(node, prefix, glob);
    }
    const scope: Scope = { name, closures: 0, decisions: [], best: [], recorded: true };
    // The lists are filled in place while the body is walked; pushing now
    // keeps `out` in source order.
    const slot: MeasuredFunction = {
      name,
      start: lineOf(startOf(node)),
      end: lineOf(node.getEnd()),
      decisions: scope.decisions,
      nestingPath: scope.best,
    };
    out.push(slot);
    return scope;
  };

  const glob: Scope = { name: `${mod}.glob`, closures: 0, decisions: [], best: [], recorded: false };

  /**
   * Walks node as part of `scope`'s own code. `path` is the stack of control
   * blocks above it; function-like nodes start a new scope.
   */
  const walk = (node: ts.Node, scope: Scope, prefix: string[], path: Step[]): void => {
    if (isFunctionLike(node)) {
      const child = scopeFor(node, scope, prefix, glob);
      // Decorator expressions run in the enclosing scope, outside the range.
      ts.forEachChild(node, (c) => (ts.isDecorator(c) ? walk(c, scope, prefix, path) : walk(c, child, [], [])));
      return;
    }
    const line = (pos: number): number => lineOf(pos);
    let level: Step | undefined;
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement: {
        const start = line(node.getStart(sf));
        scope.decisions.push({ line: start, kind: "if" });
        const parent = node.parent;
        const isElseIf = ts.isIfStatement(parent) && parent.elseStatement === node;
        if (!isElseIf) level = { line: start, kind: "if" };
        break;
      }
      case ts.SyntaxKind.ConditionalExpression:
        scope.decisions.push({
          line: line((node as ts.ConditionalExpression).questionToken.getStart(sf)),
          kind: "?:",
        });
        break;
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
        scope.decisions.push({ line: line(node.getStart(sf)), kind: "for" });
        level = { line: line(node.getStart(sf)), kind: "for" };
        break;
      case ts.SyntaxKind.WhileStatement:
        scope.decisions.push({ line: line(node.getStart(sf)), kind: "while" });
        level = { line: line(node.getStart(sf)), kind: "while" };
        break;
      case ts.SyntaxKind.DoStatement:
        scope.decisions.push({ line: line(node.getStart(sf)), kind: "do" });
        level = { line: line(node.getStart(sf)), kind: "do" };
        break;
      case ts.SyntaxKind.CaseClause:
        scope.decisions.push({ line: line(node.getStart(sf)), kind: "case" });
        break;
      case ts.SyntaxKind.CatchClause:
        scope.decisions.push({ line: line(node.getStart(sf)), kind: "catch" });
        break;
      case ts.SyntaxKind.SwitchStatement:
        level = { line: line(node.getStart(sf)), kind: "switch" };
        break;
      case ts.SyntaxKind.TryStatement:
        level = { line: line(node.getStart(sf)), kind: "try" };
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const op = (node as ts.BinaryExpression).operatorToken;
        const kind =
          op.kind === ts.SyntaxKind.AmpersandAmpersandToken
            ? "&&"
            : op.kind === ts.SyntaxKind.BarBarToken
              ? "||"
              : op.kind === ts.SyntaxKind.QuestionQuestionToken
                ? "??"
                : undefined;
        if (kind !== undefined) scope.decisions.push({ line: line(op.getStart(sf)), kind });
        break;
      }
      default:
        break;
    }
    let inner = path;
    if (level !== undefined) {
      inner = [...path, level];
      if (inner.length > scope.best.length) {
        scope.best.length = 0;
        scope.best.push(...inner);
      }
    }
    // Names for members of classes, object literals and namespaces.
    let childPrefix = prefix;
    if (!scope.recorded) {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        childPrefix = [...prefix, node.name?.text ?? classNameFromParent(node)];
      } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
        childPrefix = [...prefix, node.name.text];
      } else if (ts.isObjectLiteralExpression(node)) {
        const parent = unwrap(node).parent;
        if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          childPrefix = [...prefix, parent.name.text];
        } else if (parent !== undefined && ts.isPropertyAssignment(parent)) {
          childPrefix = [...prefix, memberName(parent.name) ?? "object"];
        }
      }
    }
    ts.forEachChild(node, (c) => walk(c, scope, childPrefix, inner));
  };

  const classNameFromParent = (node: ts.Node): string => {
    const parent = unwrap(node).parent;
    if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    return "default";
  };

  walk(sf, glob, [], []);

  return out;
}

/** Everything the CLI needs: the document for the given head tree and hunks. */
export function runTsMetrics(headDir: string, hunks: Hunks, generated: readonly string[]): MetricsDocument {
  const doc: MetricsDocument = { schema: SCHEMA, tool: "tsmetrics", records: [], files: [], skipped: [] };
  for (const file of [...hunks.keys()].sort()) {
    if (languageOf(file) !== "typescript") {
      doc.skipped.push({ path: file, reason: "unsupported-language" });
      continue;
    }
    let source: string;
    try {
      source = readFileSync(path.join(headDir, file), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        doc.skipped.push({ path: file, reason: "not-in-head" });
        continue;
      }
      throw error;
    }
    if (isGeneratedSource(file, "typescript", source, generated)) {
      doc.skipped.push({ path: file, reason: "generated" });
      continue;
    }
    const functions = analyzeTypeScript(file, source);
    const index: FunctionIndexEntry[] = functions.map((f) => [f.name, f.start, f.end]);
    const test = isTestPath(file);
    const fileIndex: FileIndex = { path: file, language: "typescript", test, functions: index };
    doc.files.push(fileIndex);
    const changed = changedLines(hunks.get(file));
    functions.forEach((fn, i) => {
      const change = classifyFunction(index[i] as FunctionIndexEntry, index, changed);
      if (change === undefined) return;
      const record: MetricsRecord = {
        path: file,
        function: fn.name,
        startLine: fn.start,
        endLine: fn.end,
        change,
        test,
        complexity: 1 + fn.decisions.length,
        decisions: fn.decisions,
        nesting: fn.nestingPath.length,
        nestingPath: fn.nestingPath,
      };
      doc.records.push(record);
    });
  }
  return doc;
}
