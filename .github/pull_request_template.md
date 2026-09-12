## Description

<!-- Please include a summary of the changes and the related issue/task. -->
<!-- Describe what this PR achieves and why it is needed. -->

## Type of Change

<!-- Please delete options that are not relevant. -->

- [ ] 🐛 Bug fix (non-breaking change which fixes an issue)
- [ ] ✨ New feature (non-breaking change which adds functionality)
- [ ] 🔨 Refactoring (code changes that neither fix a bug nor add a feature)
- [ ] 🚀 DevOps/CI (changes to CI/CD, hooks, deployment)
- [ ] 📝 Documentation update

## Quality Checklist

<!-- Verify that you have completed the following steps before submitting the PR. -->

- [ ] I have performed a self-review of my code.
- [ ] `pnpm typecheck` passes without errors.
- [ ] `pnpm lint` passes without errors (handled automatically by pre-commit hooks).
- [ ] Unit & integration tests pass locally (`pnpm test`, `pnpm test:integration`).
- [ ] E2E tests pass locally if UI/flow changes were made (`pnpm test:e2e`).
- [ ] The audit hash chain remains valid if audit logs were touched (`pnpm verify:audit`).
- [ ] PDF export functionality has been verified if print templates were modified.
- [ ] UI changes are responsive (checked on mobile & desktop dimensions).
