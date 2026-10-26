import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

const rodar = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20000 });

function pasta(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const args of [['--help'], ['help'], ['ping', '-h'], []]) {
  test(`"${args.join(' ') || '(sem argumento)'}" mostra o uso e sai 0 sem nenhuma variável de ambiente`, () => {
    const r = rodar(args);
    assert.equal(r.status, 0, r.stderr);
    for (const termo of ['FLUIG_PASS_CMD', '--env']) {
      assert.ok(r.stdout.includes(termo), `${termo} ausente do uso`);
    }
  });
}

// Só homologação configurada, com um comando de senha que deixa uma marca se rodar.
function ambienteComMarca(t) {
  const marca = join(pasta(t), 'senha-rodou');
  const env = {
    FLUIG_HOST: 'http://fluig.exemplo.invalid:8080',
    FLUIG_USER: 'fulano',
    FLUIG_PASS_CMD: `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], 'x'); console.log('s')" "${marca}"`,
  };
  return { env, marca };
}

test('controle: com esse ambiente, o loadConfig roda o comando de senha de verdade', (t) => {
  const { env, marca } = ambienteComMarca(t);
  loadConfig('teste', env);
  assert.equal(existsSync(marca), true);
});

for (const [args, mensagem] of [
  [['nada'], /desconhecido/],
  [['dataset', 'nada'], /desconhecido/],
  [['ping', '--env'], /--env/],
  [['--env', 'xyz', 'ping'], /teste.*prod/],
  // --env prod chega ao loadConfig('prod'), que recusa por falta do par de produção antes de rodar
  // qualquer comando.
  [['--env', 'prod', 'ping'], /FLUIG_HOST_PROD/],
]) {
  test(`"${args.join(' ')}" sai 1 sem rodar o comando de senha`, (t) => {
    const { env, marca } = ambienteComMarca(t);
    const r = rodar(args, env);
    assert.equal(r.status, 1, `saiu ${r.status} (${r.stderr})`);
    assert.match(r.stderr, mensagem);
    assert.equal(existsSync(marca), false, 'rodou o comando de senha');
  });
}
