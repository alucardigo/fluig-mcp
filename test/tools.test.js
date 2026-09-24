import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SERVER = new URL('../server.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FONTE = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

/** Roda o servidor em modo listagem, com ambiente controlado. */
function listar(env = {}) {
  return execFileSync(process.execPath, [SERVER, '--list'], {
    encoding: 'utf8',
    // Ambiente limpo de propósito: listar NÃO pode depender de credencial.
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
  });
}

const nomes = (saida) => saida.split('\n')
  .map((l) => l.match(/^\s*!?\s*(fluig_[a-z_0-9]+):/)).filter(Boolean).map((m) => m[1]);

test('--list roda sem nenhuma credencial', () => {
  const saida = listar();
  assert.match(saida, /fluig-mcp .* ferramentas/);
  assert.ok(nomes(saida).length > 50, 'deveria listar a superfície inteira');
});

test('modo somente leitura esconde TODA ferramenta de escrita', () => {
  const completo = nomes(listar());
  const somenteLeitura = nomes(listar({ FLUIG_READONLY: '1' }));
  assert.ok(somenteLeitura.length < completo.length, 'readonly deveria reduzir a lista');
  // A marcação `!` é o contrato visual de "isto altera o servidor".
  assert.doesNotMatch(listar({ FLUIG_READONLY: '1' }), /^\s*!\s/m, 'vazou ferramenta de escrita');
});

test('a lista de escrita cobre tudo que pede confirm', () => {
  const escrita = new Set(FONTE.match(/TOOLS_ESCRITA = new Set\(\[([\s\S]*?)\]\)/)[1].match(/fluig_[a-z_0-9]+/g));
  // Toda tool que exige `confirm` altera estado — logo tem que estar na lista de escrita.
  // Heurística por nome já errou nos dois sentidos, então a lista é curada e este teste a guarda.
  //
  // O fonte é fatiado por definição de tool: procurar `confirm` numa janela de N caracteres
  // depois do nome faz o bloco de uma tool invadir o da seguinte, e acusa como "sem confirm"
  // quem nunca pediu confirm nenhum.
  const blocos = FONTE.split(/\n  \{\n    name: '/).slice(1);
  const comConfirm = blocos
    .map((b) => ({ nome: b.match(/^(fluig_[a-z_0-9]+)'/)?.[1], temConfirm: /confirm: \{ type: 'boolean'/.test(b) }))
    .filter((t) => t.nome && t.temConfirm)
    .map((t) => t.nome);

  assert.ok(comConfirm.length > 10, `o fatiamento não achou tools com confirm (achou ${comConfirm.length})`);
  const faltando = comConfirm.filter((n) => !escrita.has(n));
  assert.deepEqual(faltando, [], `tools com confirm fora de TOOLS_ESCRITA: ${faltando.join(', ')}`);
});

test('toda ferramenta exige o parâmetro env', () => {
  // Sem isso, uma chamada sem `env` cairia num ambiente default e leria homologação
  // achando que era produção — o erro que motivou tornar `env` obrigatório.
  const semEnv = FONTE.includes("t.inputSchema.required = [...new Set([...(t.inputSchema.required || []), 'env'])]");
  assert.ok(semEnv, 'a injeção de `env` como obrigatório sumiu do server.js');
});

test('subir sem ambiente configurado falha com mensagem útil', () => {
  assert.throws(
    () => execFileSync(process.execPath, [SERVER], {
      encoding: 'utf8', timeout: 15000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }),
    (e) => {
      assert.match(String(e.stderr), /nenhum ambiente configurado/i);
      assert.match(String(e.stderr), /FLUIG_HOST/);
      return true;
    },
  );
});

test('--help e --version não exigem credencial', () => {
  const limpo = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const help = execFileSync(process.execPath, [SERVER, '--help'], { encoding: 'utf8', env: limpo });
  assert.match(help, /FLUIG_READONLY/);
  const v = execFileSync(process.execPath, [SERVER, '--version'], { encoding: 'utf8', env: limpo });
  assert.match(v.trim(), /^\d+\.\d+\.\d+$/);
});
