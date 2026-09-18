import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, sdkIdentity, source } from './identity.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const node = (await readFile(join(root, '.node-version'), 'utf8')).trim();
if (node !== process.versions.node) throw new Error(`Build requires Node ${node}`);
const sdk = await sdkIdentity(root);
const before = source(root);
await rm(join(root, 'dist'), { recursive: true, force: true });
await mkdir(join(root, 'dist/licenses'), { recursive: true });
const configurations = [
  { entry: 'src/server/index.ts', output: 'dist/server/index.js', platform: 'node', format: 'esm',
    banner: { js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);" } },
  { entry: 'src/web/index.tsx', output: 'dist/web/index.js', platform: 'browser', format: 'esm' },
  { entry: 'src/worker/index.ts', output: 'dist/worker/index.js', platform: 'browser', format: 'iife' },
];
const packageRoots = new Map();
for (const { entry, output, ...options } of configurations) {
  const result = await build({ absWorkingDir: root, entryPoints: [entry], outfile: output, bundle: true,
    target: 'es2023', sourcemap: false, legalComments: 'inline', metafile: true, ...options });
  if (options.platform === 'browser' && Object.keys(result.metafile.inputs).some(path => /node_modules.*(?:react|web-push)/.test(path))) {
    throw new Error('Browser artifact bundled forbidden runtime dependencies');
  }
  for (const path of Object.keys(result.metafile.inputs)) {
    if (!path.includes('node_modules/')) continue;
    let directory = dirname(resolve(root, path));
    while (directory !== root && directory !== dirname(directory)) {
      let metadata;
      try { metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (metadata?.name) { packageRoots.set(metadata.name, directory); break; }
      directory = dirname(directory);
    }
  }
}
for (const [name, directory] of packageRoots) {
  const files = (await readdir(directory)).filter(file => /^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(file));
  if (name === 'http_ece' && !files.length) {
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (metadata.version !== '1.2.0' || metadata.license !== 'MIT') throw new Error('Review changed http_ece license');
    await copyFile(join(root, 'licenses/http_ece-LICENSE'), join(root, 'dist/licenses/http_ece-LICENSE'));
    continue;
  }
  if (!files.length) throw new Error(`No license found for bundled dependency ${name}`);
  for (const file of files) {
    await copyFile(join(directory, file), join(root, 'dist/licenses', `${name.replaceAll('/', '_')}-${file}`));
  }
}
await copyFile(join(root, 'src/web/styles.css'), join(root, 'dist/web/styles.css'));
await writeFile(join(root, 'dist/package.json'), '{"type":"module"}\n');
if (source(root) !== before) throw new Error('Source changed during build');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const receipt = { format: 1, product: metadata.name, version: metadata.version, sourceSha: before,
  sdk, node, platform: process.platform, arch: process.arch,
  files: await inventory(root, ['cockpit.module.json', 'dist', 'LICENSE']) };
await writeFile(join(root, '.module-build.json'), `${JSON.stringify(receipt, null, 2)}\n`);
