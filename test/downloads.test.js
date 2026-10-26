import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FluigClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';

/** Cliente offline com a pasta de saída numa pasta temporária. */
function novoCliente(t) {
  const c = new FluigClient(loadConfig('teste', {
    FLUIG_HOST: 'http://fluig.exemplo.com.br:8080',
    FLUIG_USER: 'fulano',
    FLUIG_PASS: 'senha-homolog',
    FLUIG_USERCODE: 'fulano',
  }));
  c.saidaDir = mkdtempSync(join(tmpdir(), 'downloads-'));
  t.after(() => rmSync(c.saidaDir, { recursive: true, force: true }));
  return c;
}

/** Response mínima com corpo binário. */
function resposta(status, corpo, contentType = 'application/octet-stream') {
  const buf = Buffer.isBuffer(corpo) ? corpo : Buffer.from(corpo);
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
    text: async () => buf.toString('utf8'),
    headers: {
      get: (h) => ({ 'content-type': contentType, 'content-disposition': 'attachment; filename="a.pdf"' })[h.toLowerCase()] ?? null,
      getSetCookie: () => [],
    },
  };
}

/** login.do de verdade (emite s1, s2...) e as demais rotas respondendo em ordem. */
function servidorFalso(c, respostas) {
  const srv = { logins: 0, chamadas: 0 };
  c._fetch = async (path) => {
    if (path === '/portal/api/servlet/login.do') {
      srv.logins++;
      return { status: 302, ok: false, headers: { get: () => null, getSetCookie: () => [`JSESSIONIDSSO=s${srv.logins}`] } };
    }
    srv.chamadas++;
    const r = respostas.shift();
    if (!r) throw new Error(`chamada inesperada: ${path}`);
    return r;
  };
  return srv;
}

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xd8]);
const PAGINA_SAML = '<html><body><form action="https://x.fluigidentity.com/cloudpass/SPInitPost/receiveSSORequest/1">'
  + '<input type="hidden" name="SAMLRequest" value="abc"/></form></body></html>';

test('anexo baixado vai para a pasta de saída, byte a byte', async (t) => {
  const c = novoCliente(t);
  servidorFalso(c, [resposta(200, PDF, 'application/pdf')]);
  const r = await c.attachmentDownload(123, 1, 'solicitacao-123/anexo.pdf');
  assert.equal(r.arquivo, join(c.saidaDir, 'solicitacao-123', 'anexo.pdf'));
  assert.equal(r.bytes, PDF.length);
  assert.deepEqual(readFileSync(r.arquivo), PDF);
});

test('destino de download fora da pasta de saída é recusado (anexo não pode virar .git/hooks)', async (t) => {
  const c = novoCliente(t);
  servidorFalso(c, [resposta(200, '#!/bin/sh\necho pwned\n', 'text/plain'), resposta(200, PDF)]);
  const fora = join(tmpdir(), `fluig-mcp-fora-${process.pid}`, 'pre-commit');
  await assert.rejects(() => c.attachmentDownload(123, 1, fora), /fora da pasta de saída/);
  await assert.rejects(() => c.gedDownload(9, '../pre-commit'), /fora da pasta de saída/);
  assert.equal(existsSync(fora), false);
});

test('download com sessão expirada loga de novo e repete uma vez', async (t) => {
  const c = novoCliente(t);
  const srv = servidorFalso(c, [resposta(200, PAGINA_SAML, 'text/html'), resposta(200, PDF, 'application/pdf')]);
  const r = await c.attachmentDownload(123, 1, 'a.pdf');
  assert.deepEqual(readFileSync(r.arquivo), PDF);
  assert.equal(srv.logins, 2);
});

test('página de SSO nunca é gravada como se fosse o arquivo', async (t) => {
  const c = novoCliente(t);
  const srv = servidorFalso(c, [resposta(200, PAGINA_SAML, 'text/html'), resposta(200, PAGINA_SAML, 'text/html')]);
  await assert.rejects(() => c.attachmentDownload(123, 1, 'a.pdf'), /página de login\/SSO/);
  assert.equal(srv.logins, 2, 'um novo login só, sem laço');
  assert.deepEqual(readdirSync(c.saidaDir), []);
});

test('binário que contém as palavras da página de login NÃO conta como sessão expirada', async (t) => {
  const c = novoCliente(t);
  const conteudo = Buffer.from('<html><head><title>Login</title></head></html>');
  const srv = servidorFalso(c, [resposta(200, conteudo, 'application/pdf')]);
  const r = await c.attachmentDownload(123, 1, 'manual-do-login.pdf');
  assert.deepEqual(readFileSync(r.arquivo), conteudo);
  assert.equal(srv.logins, 1);
});
