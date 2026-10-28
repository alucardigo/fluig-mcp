// Casos levantados pela verificação adversarial da revisão dos PRs #2 a #7 (issue #3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FluigClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { resumoFormularios } from '../src/formularios.js';
import { gravarNaSaida, pastaSaidaPadrao } from '../src/saida.js';

function novoCliente() {
  return new FluigClient(loadConfig('teste', {
    FLUIG_HOST: 'http://fluig.exemplo.com.br:8080',
    FLUIG_USER: 'fulano',
    FLUIG_PASS: 'senha-homolog',
    FLUIG_USERCODE: 'fulano',
  }));
}

const PAGINA_SAML = '<html><body><form action="https://x.fluigidentity.com/cloudpass/SPInitPost/receiveSSORequest/1">'
  + '<input type="hidden" name="SAMLRequest" value="abc"/></form></body></html>';

test('saveGlobalEvent não grava quando a lista atual não pôde ser lida (apagaria os outros eventos)', async () => {
  const c = novoCliente();
  const gravacoes = [];
  c._rest = async (path, opts = {}) => {
    if (path.endsWith('/getEventList')) return { _status: 500, _raw: '<html>erro</html>' };
    gravacoes.push({ path, opts });
    return {};
  };
  await assert.rejects(() => c.saveGlobalEvent('beforeLogin', 'function x() {}'), /Nada foi gravado/);
  assert.equal(gravacoes.length, 0);
});

test('saveGlobalEvent: lista ilegível com a mensagem aninhada do servidor traz o motivo, sem "HTTP ?"', async () => {
  const c = novoCliente();
  c._rest = async (path) => {
    if (path.endsWith('/getEventList')) return { message: { message: 'falha de leitura' } };
    throw new Error(`não deveria chegar à gravação: ${path}`);
  };
  await assert.rejects(() => c.saveGlobalEvent('beforeLogin', 'function x() {}'), (e) =>
    /falha de leitura/.test(e.message) && !/HTTP \?/.test(e.message));
});

test('saveGlobalEvent preserva os outros eventos da lista', async () => {
  const c = novoCliente();
  let gravado;
  c._rest = async (path, opts = {}) => {
    if (path.endsWith('/getEventList')) {
      return [{ globalEventPK: { companyId: 1, eventId: 'outro' }, eventDescription: 'mantém' }];
    }
    gravado = JSON.parse(opts.body);
    return {};
  };
  await c.saveGlobalEvent('novo', 'function y() {}');
  assert.deepEqual(gravado.map((e) => e.globalEventPK.eventId), ['outro', 'novo']);
});

test('upload para o GED que volta 200 com a página de SSO é erro, não "ok"', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'upload-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const arquivo = join(dir, 'a.txt');
  writeFileSync(arquivo, 'x');
  const c = novoCliente();
  c.saidaDir = dir; // o upload só lê de dentro da pasta de saída
  c._cookie = 'JSESSIONIDSSO=s1';
  c._cookieAt = Date.now();
  c._fetch = async () => ({
    status: 200, ok: true, text: async () => PAGINA_SAML,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html' : null) },
  });
  await assert.rejects(() => c.gedUpload(arquivo, 10, { confirm: true }), /NADA foi gravado/);
  assert.equal(c._cookie, null, 'a sessão morta é descartada para o próximo pedido logar de novo');
});

test('aviso de formulários vazios cita a variável do ambiente certo', () => {
  assert.match(resumoFormularios([], '', '000123', 'FLUIG_USERCODE_PROD').aviso, /FLUIG_USERCODE_PROD/);
  assert.match(resumoFormularios([], '', '000123').aviso, /FLUIG_USERCODE/);
});

test('FLUIG_SAIDA_DIR com ~ é expandido e relativo é recusado (cairia na pasta do projeto)', () => {
  assert.equal(pastaSaidaPadrao({ FLUIG_SAIDA_DIR: '~/saida-fluig' }, homedir()), join(homedir(), 'saida-fluig'));
  assert.equal(pastaSaidaPadrao({ FLUIG_SAIDA_DIR: '~' }, homedir()), homedir());
  assert.throws(() => pastaSaidaPadrao({ FLUIG_SAIDA_DIR: 'saida' }), /caminho absoluto/);
  assert.throws(() => pastaSaidaPadrao({ FLUIG_SAIDA_DIR: './saida' }), /caminho absoluto/);
});

test('no Windows, nome reservado ou terminado em ponto/espaço é recusado', { skip: process.platform !== 'win32' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'saida-win-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const nome of ['a.', 'b ', 'sub./x.txt', 'CON', 'nul.txt', 'com1']) {
    assert.throws(() => gravarNaSaida(nome, 'x', { base: dir }), /inválido no Windows/, nome);
  }
  assert.ok(gravarNaSaida('console.txt', 'x', { base: dir }));
});
