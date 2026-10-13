import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
// Guards against build-time string mangling (e.g. "$'" in String.replace) that silently breaks the whole page.
test('every inline script in the built pages is valid JavaScript', () => {
  for (const f of ['../dist/index.html', '../dist/markets.html']) {
    if (!existsSync(new URL(f, import.meta.url))) continue;
    const html = readFileSync(new URL(f, import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, f);
    scripts.forEach((src, i) => { assert.doesNotThrow(() => new vm.Script(src), `${f} script ${i}`); });
  }
});
