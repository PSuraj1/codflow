/**
 * Fails when the lockfile is missing a Linux native binding.
 *
 * npm records only the platform-specific optional dependency matching the
 * machine that wrote the lockfile — npm/cli#4828. This one is written on
 * Windows, so every package shipping native bindings silently omits the Linux
 * one, and `npm ci` on Linux installs nothing to replace it.
 *
 * The failure is always the same shape and never at install time: the build or
 * the test run dies later with "Cannot find module '../<pkg>.linux-x64-gnu.node'".
 * It has cost this project two CI runs and a failed production deploy, once for
 * rolldown and once for lightningcss, each found the hard way.
 *
 * The fix in every case is to declare the binding in `optionalDependencies` in
 * the root package.json, which forces npm to record it. It stays optional and
 * carries `os`/`cpu` constraints, so Windows installs skip it exactly as before.
 */
import { readFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const packages = lock.packages ?? {};
const present = new Set(Object.keys(packages));

const missing = [];

for (const [name, meta] of Object.entries(packages)) {
  for (const dep of Object.keys(meta.optionalDependencies ?? {})) {
    // Only the platform CI, Docker and Render actually run on. musl and arm64
    // would be noise until something deploys to them.
    const isLinuxX64Gnu = dep.includes('linux') && dep.includes('x64') && !dep.includes('musl');
    if (isLinuxX64Gnu && !present.has(`node_modules/${dep}`)) {
      missing.push({ dep, requiredBy: name.replace('node_modules/', '') || 'root' });
    }
  }
}

if (missing.length > 0) {
  console.error('\nThe lockfile is missing Linux native bindings:\n');
  for (const { dep, requiredBy } of missing) {
    console.error(`  ${dep}   (required by ${requiredBy})`);
  }
  console.error(
    '\nThese install fine on Windows and fail on Linux at build time, not at install.',
  );
  console.error('Add each to "optionalDependencies" in the root package.json, then run:');
  console.error('  npm install --package-lock-only\n');
  process.exit(1);
}

console.log('Linux native bindings: all present in the lockfile.');
