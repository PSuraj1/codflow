import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What the production image is allowed to require.
 *
 * The runtime stage of the Dockerfile installs with `--omit=dev`, so anything
 * the compiled output requires from `devDependencies` is a module that exists
 * on every developer's machine and in no container. The failure is a crash at
 * *import time* — before the logger is up, before any handler runs — which
 * surfaces as a container that exits immediately with a stack trace nobody sees
 * because the platform is still reporting the deploy as "starting".
 *
 * `pino-pretty` is the live example: a devDependency the logger uses for
 * readable local output, attached conditionally for exactly this reason. This
 * test is what keeps that condition from being refactored away.
 *
 * It reads `dist/`, so it only means anything after a build. Skipping when the
 * directory is absent keeps `npm test` useful on a clean checkout rather than
 * failing on a file nobody has generated yet — CI runs the build first.
 */

const distDir = path.resolve(__dirname, '../../dist');
const packageJson = path.resolve(__dirname, '../../package.json');

function jsFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) found.push(full);
  }

  return found;
}

describe('production runtime dependencies', () => {
  const built = fs.existsSync(distDir);

  it.skipIf(!built)('the compiled API never requires a devDependency', () => {
    const manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8')) as {
      devDependencies: Record<string, string>;
    };

    const devDependencies = Object.keys(manifest.devDependencies);
    const offenders: string[] = [];

    for (const file of jsFiles(distDir)) {
      const source = fs.readFileSync(file, 'utf8');

      for (const dependency of devDependencies) {
        // tsc emits CommonJS here, so a static import is a `require("x")` call.
        // A bare substring match would flag the string inside a comment or a
        // transport target, which is precisely the case that is *safe*.
        const pattern = new RegExp(
          `require\\(["']${dependency.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}["']\\)`,
        );

        if (pattern.test(source)) {
          offenders.push(`${path.relative(distDir, file)} requires ${dependency}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it.skipIf(!built)('ships an entry point for both processes', () => {
    // The two commands in DEPLOYMENT.md and in every platform config. A build
    // that silently stopped emitting one of them would only be noticed by the
    // process that failed to start.
    expect(fs.existsSync(path.join(distDir, 'server.js'))).toBe(true);
    expect(fs.existsSync(path.join(distDir, 'queue', 'worker.js'))).toBe(true);
  });

  it.skipIf(!built)('does not ship the test harness or its hardcoded secret', () => {
    // `apps/api/tsconfig.json` excludes `src/tests/**` because the HTTP harness
    // is not a `*.test.ts` file and would otherwise be compiled into the image
    // carrying a hardcoded API secret.
    expect(fs.existsSync(path.join(distDir, 'tests'))).toBe(false);
  });
});
