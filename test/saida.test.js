import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { entregarTexto, MAX_CHARS_PADRAO, pastaSaidaPadrao } from '../src/saida.js';

function pasta(t) {
  const dir = mkdtempSync(join(tmpdir(), 'saida-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('texto curto volta inteiro', () => {
  assert.equal(entregarTexto('abc'), 'abc');
});

test('texto acima do limite volta cortado, com aviso de quanto faltou e como pegar tudo', () => {
  const texto = 'x'.repeat(MAX_CHARS_PADRAO + 500);
  const r = entregarTexto(texto);
  assert.ok(r.startsWith('x'.repeat(MAX_CHARS_PADRAO)));
  assert.match(r, /500 de \d+ caracteres omitidos/);
  assert.match(r, /destino/);
  assert.equal(entregarTexto('abcdef', { maxChars: 3 }).slice(0, 3), 'abc');
});

test('com destino grava o conteúdo inteiro dentro da pasta base (criando subpastas) e devolve só o resumo', (t) => {
  const dir = pasta(t);
  const texto = '<x>' + 'á'.repeat(30000) + '</x>';
  const destino = join(dir, 'proc.xml');
  assert.deepEqual(entregarTexto(texto, { destino, base: dir }), { arquivo: destino, caracteres: texto.length });
  assert.equal(readFileSync(destino, 'utf8'), texto);
  assert.equal(entregarTexto('y', { destino: 'sub/rel.txt', base: dir }).arquivo, join(dir, 'sub', 'rel.txt'));
});

test('a pasta padrão fica na home do usuário, não na pasta onde o MCP roda', () => {
  // A pasta de trabalho é o projeto (dava para sobrescrever .git/hooks) ou "/" (Claude Desktop no macOS,
  // onde criar a pasta falha com EACCES). A home é do usuário e sempre gravável.
  assert.equal(pastaSaidaPadrao({}, '/home/fulano'), join('/home/fulano', 'fluig-mcp-saida'));
  assert.equal(pastaSaidaPadrao({ FLUIG_SAIDA_DIR: '/saidas' }, '/home/fulano'), '/saidas');
  assert.equal(pastaSaidaPadrao({}), join(homedir(), 'fluig-mcp-saida'));
});

test('pasta de saída que não dá para criar vira erro que cita FLUIG_SAIDA_DIR', (t) => {
  const dir = pasta(t);
  const arquivo = join(dir, 'sou-um-arquivo');
  writeFileSync(arquivo, '');
  assert.throws(() => entregarTexto('x', { destino: 'a.txt', base: join(arquivo, 'saida') }), /FLUIG_SAIDA_DIR/);
});

test('destino fora da pasta base é recusado (o conteúdo vem do servidor; não pode virar ~/.bashrc)', (t) => {
  const dir = pasta(t);
  assert.throws(() => entregarTexto('x', { destino: '../fora.txt', base: dir }), /FLUIG_SAIDA_DIR/);
  assert.throws(() => entregarTexto('x', { destino: join(tmpdir(), 'fora.txt'), base: dir }), /fora da pasta/);
  assert.throws(() => entregarTexto('x', { destino: '.', base: dir }), /fora da pasta/);
});

test('links simbólicos dentro da base não servem de saída', { skip: process.platform === 'win32' }, (t) => {
  const dir = pasta(t);
  const base = join(dir, 'base');
  const fora = join(dir, 'fora');
  mkdirSync(base);
  mkdirSync(fora);
  symlinkSync(fora, join(base, 'atalho'));
  assert.throws(() => entregarTexto('x', { destino: 'atalho/a.txt', base }), /fora da pasta/);
  assert.equal(existsSync(join(fora, 'a.txt')), false);
  assert.throws(() => entregarTexto('x', { destino: 'atalho/sub/a.txt', base }), /fora da pasta/);
  assert.equal(existsSync(join(fora, 'sub')), false, 'nem a subpasta pode ser criada fora');

  symlinkSync(join(fora, 'nao-existe'), join(base, 'quebrado'));
  assert.throws(() => entregarTexto('x', { destino: 'quebrado/a.txt', base }), /fora da pasta/);
  assert.equal(existsSync(join(fora, 'nao-existe')), false);

  writeFileSync(join(fora, 'alvo.txt'), 'original');
  symlinkSync(join(fora, 'alvo.txt'), join(base, 'link.txt'));
  assert.throws(() => entregarTexto('x', { destino: 'link.txt', base }), /link simbólico/);
  assert.equal(readFileSync(join(fora, 'alvo.txt'), 'utf8'), 'original');
});
