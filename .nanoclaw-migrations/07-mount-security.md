# 07 — Mount allowlist string-form normalization

**Apply when:** After all skill merges. Independent customization on `src/mount-security.ts`.

**Why:** The allowlist file accepts entries as either plain strings (`"/some/path"`) or objects (`{ path: "...", allowReadWrite: false }`). The skill version assumes objects only. The user added a normalization pass so a config file with mixed forms doesn't crash on load — strings are auto-promoted to read-only objects.

**Files affected:**
- `src/mount-security.ts`

---

## How to apply

In `src/mount-security.ts`, find `loadMountAllowlist()`. After the validation that throws if `allowedRoots` isn't an array, add a normalization map. Insert this 5-line block between the `allowedRoots` array check and the `blockedPatterns` array check:

```typescript
// Normalize plain string entries to AllowedRoot objects
allowlist.allowedRoots = allowlist.allowedRoots.map(
  (root: AllowedRoot | string) =>
    typeof root === 'string' ? { path: root, allowReadWrite: false } : root,
);
```

Final layout in context:

```typescript
if (!Array.isArray(allowlist.allowedRoots)) {
  throw new Error('allowedRoots must be an array');
}

// Normalize plain string entries to AllowedRoot objects
allowlist.allowedRoots = allowlist.allowedRoots.map(
  (root: AllowedRoot | string) =>
    typeof root === 'string' ? { path: root, allowReadWrite: false } : root,
);

if (!Array.isArray(allowlist.blockedPatterns)) {
  throw new Error('blockedPatterns must be an array');
}
```

If the new upstream has refactored this function, find the equivalent point: after `allowedRoots` is confirmed to be an array, before any code reads `.path` or `.allowReadWrite` on its entries.

---

## Verification

Add a test allowlist file with both forms and run the loader:

```yaml
# test-allowlist.yml
allowedRoots:
  - /Users/me/Documents          # string form
  - path: /Users/me/Code         # object form
    allowReadWrite: true
blockedPatterns: []
```

Confirm `loadMountAllowlist()` returns objects for both entries and the string form has `allowReadWrite: false`.

---

## Reasoning to retain

Original commit: `f4fe718 fix: container improvements — Python 3.13, ffmpeg, QMD conditional, uid handling` (this 6-line normalization was bundled in).

Read-only-by-default is a safety choice — string-form entries are interpreted as untrusted by default until the user explicitly opts into writable.
