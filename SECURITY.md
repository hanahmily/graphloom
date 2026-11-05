# Security policy

## Supported versions

Only the latest release of GraphLoom receives security fixes. Until the first
release is published, the `main` branch is the supported version.

## Reporting a vulnerability

Please do not open a public issue or pull request for a security problem.

Report it privately through GitHub's private vulnerability reporting: open the
repository's **Security** tab on <https://github.com/hanahmily/graphloom>, choose
**Report a vulnerability**, and describe the problem (a security advisory draft).
Include the affected version or commit, the steps to reproduce it, and the impact
you expect.

You can expect an acknowledgement within a few days. We will work with you on a fix
and agree on a disclosure date before anything is published.

## Scope

GraphLoom runs graph plugins and coding agents on your machine with scoped
filesystem, credential, network, and process access. Reports about a way out of
those scopes, a credential reaching a plugin or agent that should not see it, or a
controller state or receipt that can be forged are in scope. Behavior that the
operator explicitly enables, such as `allowUnrestricted` in the runner
configuration, is documented and is not by itself a vulnerability.
