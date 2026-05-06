---
name: auto-update
description: Stash any uncommitted changes, then run /update-nanoclaw and /update-skills, then restore the stash. Designed for unattended daily runs.
---

# About

Wraps the manual upgrade flow into a single command suitable for automation:

1. Stash uncommitted changes (if any) with a timestamped message.
2. Run `/update-nanoclaw` to merge upstream into your install.
3. Run `/update-skills` to refresh every installed `skill/*` branch.
4. Pop the stash you created (if any), surfacing any conflicts.

Run `/auto-update` in Claude Code — or let the scheduled routine fire it daily.

## Operating principles

- Never lose user work: every stash gets a message, the message is reported in the summary, and `git stash list` is shown at the end so the user can recover even if pop fails.
- Both updaters refuse to run on a dirty tree, so stashing is a hard requirement, not a nicety.
- Prefer non-interactive paths. When `/update-nanoclaw` or `/update-skills` would prompt with AskUserQuestion, choose the safe default automatically (full merge, all skills) and note the choice in the summary. If a real conflict requires human judgement, abort that step, leave the tree clean, and report it.
- This skill never deletes branches, force-pushes, or rewrites history.

# Step 0: Record starting state

Capture for the summary:

- `START_HASH=$(git rev-parse --short HEAD)`
- `START_BRANCH=$(git rev-parse --abbrev-ref HEAD)`
- `START_TIME=$(date +%Y-%m-%d-%H%M%S)`

# Step 0.5: Recover orphan stash from a prior incomplete run

A previous `auto-update` run may have stashed and died before popping. Recover before doing anything else, so the user's stashed work doesn't sit around for days.

- `git stash list | grep -E '^stash@\{[0-9]+\}: On [^:]+: auto-update '`

If any matching entries exist:
- Pick the **oldest** one (highest `stash@{N}` index among matches) — that is the longest-orphaned and most likely to be lost work.
- Run `git stash show --name-only <ref>` and check overlap against:
  - **Dirty tree paths** (`git status --porcelain`): would clobber unsaved work.
  - **Tracked files at HEAD**: an untracked-stashed path may now exist as tracked (e.g. the skill file got committed since the stash was made). `git stash apply` will refuse with "already exists, no checkout" in that case.
  - For each path in the stash, compare its content against the current file at the same path. If identical (`git show stash@{N}:<path>` matches the working tree file byte-for-byte), the stash is fully redundant — drop it directly with `git stash drop <ref>` and record `Dropped redundant orphan stash: <ref>` in the summary. No apply needed.
- If any path in the stash overlaps a dirty path or a non-identical tracked path, skip recovery for this run and surface as `ACTION NEEDED: orphan auto-update stash <ref> overlaps current state — resolve manually` in the summary.
- Otherwise (no overlap, no redundancy): run `git stash apply <ref>`. If the apply is clean (no conflict markers, exit 0), then `git stash drop <ref>` and record `Recovered orphan stash: <ref>` in the summary.
- If the apply reports conflicts, leave the stash and the conflict markers in place, abort this auto-update run, and surface `ACTION NEEDED: orphan stash <ref> applied with conflicts — resolve manually`. Do **not** run `git stash drop`.
- Repeat for any remaining matching stashes (oldest first), but stop at the first one that requires manual intervention.

After recovery, the tree may now be dirty (with restored work). That is fine — Step 1 will stash it back under a fresh timestamp.

# Step 1: Stash if dirty

Check working tree:

- `git status --porcelain`

If output is empty:
- Set `STASHED=false` and skip to Step 2.

If output is non-empty:
- `STASH_MSG="auto-update $START_TIME"`
- `git stash push --include-untracked -m "$STASH_MSG"`
- Set `STASHED=true` and remember `STASH_MSG`.
- Confirm clean tree: `git status --porcelain` should now be empty. If it is not (e.g. ignored-but-tracked files, submodules), abort: pop the stash with `git stash pop` and tell the user the working tree could not be made clean automatically.

# Step 2: Run /update-nanoclaw

Invoke the `update-nanoclaw` skill via the Skill tool.

When that skill asks via AskUserQuestion:
- **Update path** (Step 2 of update-nanoclaw): choose **Full update** (option A — merge all upstream changes). Never pick Rebase (per-commit conflicts), Selective (requires human curation), or Abort.
- **Proceed despite conflicts preview** (Step 3): if the dry-run lists conflicts, abort the update, run `git merge --abort` defensively, and skip to Step 4 with a note that nanoclaw was not updated this run.
- **Breaking changes migration skills** (Step 6): choose **Skip — I'll handle these manually**. Surface the breaking-change list verbatim in the final summary so the user sees it tomorrow.
- **Skill branches prompt** (Step 7a): choose **No, skip** — this skill always runs `/update-skills` itself in Step 3, no need to double-run.
- **Channel/provider updates** (Step 7b): choose **Skip — I'll update them later**. Surface the list of installed channels/providers in the summary so the user can re-run their `/add-<name>` skills if they want.

If `update-nanoclaw` errors out (build failure, unresolvable conflict, etc.), do not bail on the whole run. Record the failure and proceed to Step 3 — `/update-skills` may still succeed, and we still need to pop the stash.

# Step 3: Run /update-skills

Only run if Step 2 left the tree clean. Verify with `git status --porcelain` — if non-empty, skip Step 3 and record "skipped: tree not clean after update-nanoclaw".

Invoke the `update-skills` skill via the Skill tool.

When that skill asks via AskUserQuestion:
- **Which skills to update** (Step 2): pick **all skills with updates available**. Do not pick Skip.

Same failure handling as Step 2: record and continue.

# Step 4: Pop the stash

This step **must run** even if Step 2 or Step 3 errored out — that is the whole point of recording failures and continuing instead of bailing. The most common cause of a broken `auto-update` skill is the wrapper dying before this step.

Only if `STASHED=true`.

- `git stash pop`

If pop succeeds cleanly: record success.

If pop reports conflicts:
- Do **not** try to resolve them automatically — the user's in-progress work is here and only they know the right resolution.
- Leave the conflicts in the tree.
- The stash entry is automatically kept by git when pop conflicts (it is not dropped). Confirm with `git stash list` and surface the stash ref in the summary.

If pop fails for another reason (e.g. ref no longer exists):
- Run `git stash list` and report the full list. Do not run `git stash drop`.

# Step 5: Summary

Always print, even if earlier steps failed:

- Start: `$START_HASH` on `$START_BRANCH` at `$START_TIME`
- End: `git rev-parse --short HEAD` on `git rev-parse --abbrev-ref HEAD`
- Stash: `$STASH_MSG` (created? popped cleanly? popped with conflicts? still in `git stash list`?)
- update-nanoclaw: succeeded / aborted-on-conflict / failed (with one-line reason)
- update-skills: succeeded / skipped / failed (with one-line reason)
- Breaking changes detected (if any): full list from update-nanoclaw Step 6
- Channels/providers installed (if update-nanoclaw mentioned any): full list, with the suggestion to re-run their `/add-<name>` skills manually
- Final `git stash list` output (full)
- If anything failed or needs human follow-up, end with a one-line "ACTION NEEDED:" summary so the user can grep for it in the daily output.

If the service is running and either updater succeeded, remind the user to restart:
- macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- Linux: `systemctl --user restart nanoclaw`
