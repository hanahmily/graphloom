// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

export { createScope, type TestScope } from "./scope.js";
export { createGitRepo, exampleBundle, execFileAsync, repoRoot, type GitRepo, type GitRepoOptions } from "./git.js";
export { createTaskWorkspace, type TaskBudgets, type TaskLayout, type TaskWorkspace, type TaskWorkspaceOptions } from "./task.js";
export {
  EXTREME_BUDGETS,
  GRAPHLOOM_DIR,
  NODE_MAX_TIMER_MS,
  TRACKED_GRAPHLOOM_FILES,
  ignoreGraphloomDir,
  trackUnderGraphloomDir,
  watchProcessWarnings,
  type WarningWatch,
} from "./conditions.js";
export { bumpBundleVersion, copyBundle, slowBundle, type SlowBundleOptions } from "./bundles.js";
export {
  FAULTS,
  QUOTA_429_NO_RESET_BODY,
  TRANSIENT_500_BODY,
  startFakeProvider,
  type AnthropicRequest,
  type FakeProvider,
  type FakeProviderOptions,
  type ProviderFault,
  type TextReply,
  type ToolCall,
} from "./provider.js";
export {
  HELLO_GREETING,
  HELLO_REQUEST,
  agentOutput,
  helloAgents,
  scriptedAgents,
  type AgentReply,
  type ScriptedAgents,
  type ScriptedAgentsOptions,
} from "./agents.js";
export {
  ISSUE_FIX_BUGGY,
  ISSUE_FIX_CHANGES,
  ISSUE_FIX_FALSE_POSITIVE,
  ISSUE_FIX_FIXED,
  ISSUE_FIX_ISSUE,
  ISSUE_FIX_LOW_FINDING,
  ISSUE_FIX_PLAN,
  ISSUE_FIX_REGRESSION,
  ISSUE_FIX_TEST,
  createIssueFixFixture,
  goVersion,
  issueFixAgents,
  issueFixRepoFiles,
  type FakeAgentConfig,
  type IssueFixFixture,
  type IssueFixFixtureOptions,
} from "./issue-fix.js";
export { prependPath } from "./env.js";
export { startHttpsGit, type HttpsGitServer } from "./https-git.js";
