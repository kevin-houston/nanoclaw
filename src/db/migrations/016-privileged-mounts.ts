import type { Migration } from './index.js';

/**
 * Local customization: `privileged_mounts` on `container_configs`.
 *
 * Mounts that land at an operator-chosen absolute container path (e.g.
 * `/var/run/docker.sock`) instead of under the allowlist's `/workspace/extra/`
 * prefix. Composed as `allowlisted-extra` in `buildMounts` — see
 * `src/mount-composition.test.ts` for the admission case.
 *
 * Portable (plain `ALTER TABLE ... ADD COLUMN`), so it carries no `sqliteOnly`
 * marker and stays inside the post-boundary portability policy.
 */
export const migration016: Migration = {
  version: 16,
  name: 'privileged-mounts',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN privileged_mounts TEXT NOT NULL DEFAULT '[]';`);
  },
};
