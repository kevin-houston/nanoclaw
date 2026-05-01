# 08 — `.gitignore` `.env*` + remove auto-sync workflows

**Apply when:** Final pass. Two trivial but durable changes.

---

## 1. `.gitignore` — broaden `.env` to `.env*`

**Why:** `.env~` editor backups and `.env_old` manual snapshots otherwise show up as untracked and risk accidentally being committed.

**File:** `.gitignore`

**Change:** Replace the line `.env` with `.env*`. Final shape:

```gitignore
# Secrets
*.keys.json
.env*
```

If upstream has reshaped `.gitignore`, find any line that exactly matches `.env` and change it to `.env*`.

**Reasoning to retain:** Original commit: `e681a0a chore: ignore all .env* files (backups, variants)`.

---

## 2. Remove auto-sync GitHub Actions workflows

**Why:** These two workflows auto-commit version bumps and token-count doc updates on the upstream `qwibitai/nanoclaw` repo. They aren't relevant to the user's fork (which has different versioning and doesn't run these CI jobs), and they create noise / merge churn when upstream commits run them.

**Files to delete:**
- `.github/workflows/bump-version.yml`
- `.github/workflows/update-tokens.yml`

**How to apply:**

In the upgrade worktree, after merging upstream:

```bash
rm .github/workflows/bump-version.yml
rm .github/workflows/update-tokens.yml
```

If the new upstream has renamed or merged these into other workflows, inspect what's there and decide whether the user's intent (no auto-bump, no auto-token-count on this fork) still applies. If a single workflow now does both jobs, deleting it is the equivalent action.

**Reasoning to retain:** Original commit: `e9426da chore: remove auto-sync GitHub Actions`.
