import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { COMANDOS, nomeDeArquivo } from '../bin/cli.js';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

const rodar = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20000 });

function pasta(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Silencia o que o comando imprime: o teste confere o efeito, não o texto.
function calar(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
}

for (const args of [['--help'], ['help'], ['ping', '-h'], []]) {
  test(`"${args.join(' ') || '(sem argumento)'}" mostra o uso e sai 0 sem nenhuma variável de ambiente`, () => {
    const r = rodar(args);
    assert.equal(r.status, 0, r.stderr);
    for (const termo of ['FLUIG_PASS_CMD', 'FLUIG_SAIDA_DIR', '--env', '--out']) {
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

test('nome de arquivo vindo do servidor precisa ser um nome simples', () => {
  for (const ruim of ['../x', '..', '.', '', 'a/b', 'a\\b', '/etc/passwd', 'C:\\x', 'C:x', '../../x.js', 'a\0b']) {
    assert.throws(() => nomeDeArquivo(ruim), /recusado/, JSON.stringify(ruim));
  }
  for (const bom of ['form.html', '..config', 'displayFields.js', 'logo empresa.png']) {
    assert.equal(nomeDeArquivo(bom), bom);
  }
});

test('form get recusa nome de arquivo do servidor com ../ e não grava fora da pasta', async (t) => {
  calar(t);
  const raiz = pasta(t);
  const saida = join(raiz, 'saida');
  const pedidos = [];
  const cliente = {
    getFormFileNames: async () => ['ok.html', '../../fora.html'],
    getFormFileBase64: async (_id, _versao, nome) => {
      pedidos.push(nome);
      return Buffer.from([0xff, 0x00, 0x41]).toString('base64');
    },
    getFormEvents: async () => [],
  };
  await assert.rejects(COMANDOS['form get'](cliente, { args: ['7'], opcoes: {}, saida }), /recusado/);
  assert.deepEqual(pedidos, ['ok.html'], 'o nome ruim nem chega a ser baixado');
  assert.equal(existsSync(join(raiz, 'fora.html')), false);
  // forms/7/../../fora.html cairia DENTRO da pasta de saída, sobre outro arquivo: também é recusado.
  assert.equal(existsSync(join(saida, 'fora.html')), false);
  // Arquivo de formulário pode ser binário (imagem): grava os bytes, sem passar por texto.
  assert.deepEqual([...readFileSync(join(saida, 'forms', '7', 'ok.html'))], [0xff, 0x00, 0x41]);
});

test('evento com id que sai da pasta é recusado', async (t) => {
  calar(t);
  const raiz = pasta(t);
  const saida = join(raiz, 'saida');
  const cliente = { getFormEvents: async () => [{ eventId: '../../../fora', eventDescription: 'x' }] };
  await assert.rejects(COMANDOS['form events'](cliente, { args: ['7'], opcoes: {}, saida }), /recusado/);
  assert.equal(existsSync(join(raiz, 'fora.js')), false);
});
