import { createHash } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

/** Every file under `dir` with its SHA-256, backups and temp files aside. */
export async function snapshotProject(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, prefix: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const rel = prefix + e.name;
      if (e.isDirectory()) await walk(join(d, e.name), rel + '/');
      else if (!/\.(bak|tmp)$/.test(e.name)) out[rel] = createHash('sha256').update(await readFile(join(d, e.name))).digest('hex');
    }
  };
  await walk(dir, '');
  return out;
}
