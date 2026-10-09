import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
async function check(path) { for (const item of await readdir(path, {withFileTypes: true})) { const file = `${path}/${item.name}`; if (item.isDirectory()) await check(file); else if (file.endsWith('.mjs')) { const result = spawnSync(process.execPath, ['--check', file], {stdio: 'inherit'}); if (result.status) process.exit(result.status); } } }
for (const folder of ['server', 'web', 'scripts']) await check(folder);
