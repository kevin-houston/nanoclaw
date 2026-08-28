import type { Migration } from './index.js';

/**
 * Privileged mounts on `container_configs`.
 *
 * Operator-opted mounts that bypass the mount-security allowlist and land at
 * their specified absolute container paths (e.g. /var/run/docker.sock).
 * Defaults to an empty JSON array, so existing rows keep today's behavior.
 */
export const migration016: Migration = {
  version: 16,
  name: 'privileged-mounts',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN privileged_mounts TEXT NOT NULL DEFAULT '[]';`);
  },
};
