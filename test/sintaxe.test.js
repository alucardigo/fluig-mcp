import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Varre os arquivos em vez de listá-los à mão: a lista fixa do `npm run check` tinha ficado para
// trás (módulos novos e o bin da CLI fora dela), e um erro de sintaxe na CLI seria publicado verde.
const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const ARQUIVOS = [
  'server.js',
  ...readdirSync(join(RAIZ, 'bin')).filter((f) => f.endsWith('.js')).map((f) => `bin/${f}`),
  ...readdirSync(join(RAIZ, 'src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`),
];

for (const arquivo of ARQUIVOS) {
  test(`sintaxe: ${arquivo}`, () => {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', join(RAIZ, arquivo)], { stdio: 'pipe' }));
  });
}
