# Pi SDK and Claude subscription authentication

Verified 2026-09-23 against current official docs and Pi v0.87.1 source. Read-only research; no credentials accessed, logins attempted, or model calls made.

**Conclusion:** Pi can technically authenticate with Anthropic OAuth today, but that does not establish access to the included Claude Pro/Max allowance. For GraphLoom's native Pi backend, use Anthropic API credentials with separate API billing. If using an existing Claude subscription is essential, model genuine Claude Code execution as a separate harness backend.

## Current Pi implementation

- The latest release shown is 0.87.1, dated September 22, 2026. The SDK package is `@earendil-works/pi-coding-agent`. [Pi changelog](https://pi.dev/changelog), [SDK documentation](https://pi.dev/docs/latest/sdk).
- **Do not claim Anthropic OAuth was removed from Pi.** The v0.87.1 provider explicitly registers `Anthropic (Claude Pro/Max)` with `isSubscription: true`. The corresponding current auth module implements browser login, refresh, and conversion to request credentials. [Pinned provider source](https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/providers/anthropic.ts), [current OAuth source](https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/anthropic.ts).
- Pi's current UI explicitly warns that Anthropic subscription authentication in third-party harnesses draws from metered extra usage rather than the Claude plan allowance. This is stronger evidence than an OAuth option's display name; it is a Pi implementation statement, not an independently measured billing result. [Pinned warning source, lines 281–282](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L281).
- Current provider documentation lists `ANTHROPIC_API_KEY`, recognizes `ANTHROPIC_OAUTH_TOKEN` and bearer `ANTHROPIC_AUTH_TOKEN`, and documents credential storage. Technical token acceptance is distinct from subscription eligibility. [Provider authentication](https://pi.dev/docs/latest/providers).

## What Anthropic documents

- Claude Pro/Max subscribers can authenticate to **Claude Code itself** with their Claude account. [Claude Code authentication](https://code.claude.com/docs/en/authentication).
- The current policy distinguishes running unmodified Claude Code, with each end user completing Anthropic's own authentication, from a third-party application collecting or routing subscription credentials. It allows the former subject to its listed Commercial Terms conditions; developers should use API keys for their own Claude applications. [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products).
- The official Agent SDK runs the Claude Code binary, but its overview still directs third-party products to API-key authentication unless Anthropic previously approved offering Claude.ai login/rate limits. Do not infer blanket product permission merely from the SDK wrapping Claude Code. [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).
- Claude subscriptions and Claude API/Console billing are separate. An API key is not a way to consume the subscription's included usage. [Anthropic billing explanation](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console).

## GraphLoom design implication (inference)

Keep the supervisor's backend choice separate from its model choice:

| Execution backend | Claude authentication/billing expectation |
| --- | --- |
| Native Pi SDK | Anthropic API key, separately billed; built-in OAuth exists but must not be promised as included Pro/Max usage |
| Genuine Claude Code subprocess | Claude Code owns its login, tools, context, and session; own-account subscription authentication is documented, subject to its usage and product conditions |

The second row is a harness adapter, not an Anthropic model provider inside Pi's agent loop. Switching into it requires explicit task/context handoff; it does not preserve Pi's live session merely by changing a model ID. Avoid credential copying, third-party OAuth recreation, or identity/header rewriting as the architecture's subscription solution.

No historical removal event was established; the verified current implementation is decisive for the current question. No claim of successful live OAuth inference or billing was tested.
