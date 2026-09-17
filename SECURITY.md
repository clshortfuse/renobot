# Security policy

## Supported versions

Renobot is currently pre-release. Security fixes are applied to the latest
revision on the default branch; older revisions are not supported.

## Reporting a vulnerability

Do not disclose security vulnerabilities in a public issue, discussion, pull
request, Discord channel, or chat transcript.

Use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** tab.
2. Select **Advisories**.
3. Select **Report a vulnerability**.

Include the affected revision, impact, reproduction steps, and any suggested
mitigation. Remove credentials, Discord message content, personal data, and
other third-party secrets from the report. If a credential may have been
exposed, identify its type without including its value.

The maintainers will acknowledge a report when reviewed, investigate it
privately, and coordinate disclosure after a fix or mitigation is available.
No response-time or remediation-time guarantee is currently offered.

## Scope

Relevant reports include authentication or authorization bypasses, credential
exposure, unsafe Discord content handling, command-scope violations, deployment
workflow compromise, and vulnerabilities in Renobot's original code.

For vulnerabilities in a dependency or external service, report the issue to
that project's security contact as well. General support requests and feature
suggestions belong in the repository's ordinary issue tracker.
