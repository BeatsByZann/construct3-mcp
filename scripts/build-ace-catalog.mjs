#!/usr/bin/env node
// Developer tool: make the ACE catalogue cache file of one Construct release.
//   node scripts/build-ace-catalog.mjs <release> [--from <folder>] [--out <file>]
// It fills the cache before going offline. The server never calls it.
import { homedir } from 'node:os';

let runBuildCatalog;
try {
  ({ runBuildCatalog } = await import('../dist/construct3/ace-catalog-source.js'));
} catch (error) {
  if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('Run npm run build first.');
    process.exit(2);
  }
  throw error;
}

process.exitCode = await runBuildCatalog(process.argv.slice(2), {
  fetch: globalThis.fetch,
  env: process.env,
  platform: process.platform,
  home: homedir(),
  out: console.log,
  err: console.error,
});
