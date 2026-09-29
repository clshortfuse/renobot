---
name: code-review
description: 'Review Renobot code changes, staged diffs, commits, or pull requests for correctness, security, deployment risk, and missing tests. Use when asked to review code, a staged change, a branch, or a PR before merge.'
argument-hint: 'Optional diff, commit, branch, or PR to review; defaults to staged changes'
---

# Code review

Review the requested change without editing, staging, committing, pushing, or deploying it. A review is an investigation, not an approval based solely on passing checks.

## Establish the review target

1. Determine the requested scope: staged changes by default; otherwise the specified working-tree diff, commit, branch, or PR. For a PR, compare its head to the merge base with its base branch, not just the last commit. Do not silently substitute a different diff.
2. Check the branch, working-tree state, and diff summary. Distinguish staged, unstaged, and untracked files. Do not discard or alter any of them.
3. Read the changed code and enough surrounding callers, data models, tests, and configuration to understand each affected path. Trace inputs to outputs and failure handling; do not infer behavior from filenames or tests alone.

## Examine risks

- **Behavior:** Verify boundary cases, concurrency, retries, idempotency, state transitions, and error handling. Check that tests exercise real failure modes, not only mocked happy paths.
- **Trust boundaries:** Treat Discord content and webhook payloads as untrusted. Check authorization against current roles, account ownership, CSRF and session handling, secrets, request limits, and accidental data exposure. Distinguish test-only endpoints from payment or entitlement processing.
- **Persistence:** Compare Prisma schema, SQL migrations, repository queries, and integration tests. Check uniqueness, transactions, foreign keys, and migration/rollback implications; do not assume an image rollback reverses a database migration.
- **Deployment:** Follow settings from GitHub Actions through Compose and host environment into runtime. Check Docker mounts, permissions, public static files, Nginx routes/timeouts, health checks, and whether deployment instructions match what automation actually does.
- **Project conventions:** Apply `.github/copilot-instructions.md`. Keep Node.js ESM JavaScript, JSDoc/checkJs, the minimal Discord intent set, and the owner/guild scope unless the change explicitly expands them.

Run focused checks when practical; for database changes, use the disposable `npm run db:test` runner rather than a configured production database. Run `npm run check` when the review needs fresh validation. Tests passing does not replace code inspection. Do not run live deployments, alter host services, or send real Ko-fi deliveries as part of a review.

## Report

1. Verify every suspected defect against the actual code path and remove speculative findings. Give each confirmed finding a severity, exact file and line reference, triggering scenario, and concrete impact. Prefer a small number of consequential findings over style suggestions.
2. List findings in descending severity. Separate blocking defects from non-blocking suggestions; do not present unverified concerns as confirmed bugs.
3. If no actionable findings remain, say so explicitly. State what was reviewed and which checks were or were not run, along with material limitations such as untested live integrations. Do not claim deployment or production behavior was verified by local tests.