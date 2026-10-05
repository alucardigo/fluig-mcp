import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FluigClient, sessaoExpirada } from '../src/client.js';
import { loadConfig } from '../src/config.js';

/** Cliente apontado para um host que nunca é contatado: os testes daqui ficam offline. */
function novoCliente() {
  return new FluigClient(loadConfig('teste', {
    FLUIG_HOST: 'http://fluig.exemplo.com.br:8080',
    FLUIG_USER: 'fulano',
    FLUIG_PASS: 'senha-homolog',
  }));
}

const PAGINA_SAML = '<form action="https://x.fluigidentity.com/cloudpass/SPInitPost/receiveSSORequest/1">'
  + '<input type="hidden" name="SAMLRequest" value="abc"/></form>';

/** Substituto mínimo de uma Response do fetch. */
function resposta(status, text) {
  return { status, ok: status >= 200 && status < 300, text: async () => text, headers: new Map() };
}

test('reconhece sessão expirada por 401, desvio SAML e página de login', () => {
  assert.equal(sessaoExpirada(401, ''), true);
  assert.equal(sessaoExpirada(200, PAGINA_SAML), true);
  assert.equal(sessaoExpirada(200, '<html><title>Login</title></html>'), true);
  assert.equal(sessaoExpirada(200, '<form action="j_security_check"><input name="j_username"></form>'), true);
  assert.equal(sessaoExpirada(200, '{"content":[]}'), false);
  assert.equal(sessaoExpirada(403, 'FortiGuard Web Filter Violation'), false);
});

test('REST com sessão expirada loga de novo e repete uma vez', async () => {
  const c = novoCliente();
  let logins = 0;
  c.login = async () => `JSESSIONIDSSO=s${++logins}`;
  c._descartarSessao = () => {};
  const cookies = [];
  const respostas = [resposta(200, PAGINA_SAML), resposta(200, '{"ok":true}')];
  c._fetch = async (_path, opts) => { cookies.push(opts.headers.Cookie); return respostas.shift(); };

  assert.deepEqual(await c._rest('/api/x'), { ok: true });
  assert.equal(logins, 2);
  assert.deepEqual(cookies, ['JSESSIONIDSSO=s1', 'JSESSIONIDSSO=s2']);
});

test('sessão que continua expirada após o novo login é devolvida, sem laço de login', async () => {
  const c = novoCliente();
  let logins = 0;
  c.login = async () => `JSESSIONIDSSO=s${++logins}`;
  c._descartarSessao = () => {};
  let chamadas = 0;
  c._fetch = async () => { chamadas++; return resposta(200, PAGINA_SAML); };

  const r = await c._rest('/api/x');
  assert.equal(r._status, 200);
  assert.match(r._raw, /SAMLRequest/);
  assert.equal(logins, 2, 'só um novo login por chamada (protege o lockout do AD)');
  assert.ok(chamadas <= 4, `chamadas demais: ${chamadas}`);
});

test('REST cru também loga de novo uma vez com sessão expirada', async () => {
  const c = novoCliente();
  let logins = 0;
  c.login = async () => `JSESSIONIDSSO=s${++logins}`;
  c._descartarSessao = () => {};
  const respostas = [resposta(401, ''), resposta(200, '<xml/>')];
  c._fetch = async () => respostas.shift();

  const r = await c._restRaw('/api/x', { accept: 'application/xml' });
  assert.equal(r.status, 200);
  assert.equal(r.text, '<xml/>');
  assert.equal(logins, 2);
});

test('cookie parado é revalidado e trocado quando o ping falha', async () => {
  const c = novoCliente();
  c._cookie = 'JSESSIONIDSSO=antigo';
  c._cookieAt = Date.now() - 60 * 60_000;
  c._soap = { '/webdesk/X?wsdl': {} };
  c._sessaoViva = async () => false;
  c._fetch = async () => ({ status: 302, headers: { getSetCookie: () => ['JSESSIONIDSSO=novo; Path=/'] } });

  assert.equal(await c.login(), 'JSESSIONIDSSO=novo');
  assert.deepEqual(c._soap, {}, 'clientes SOAP com o cookie antigo são descartados');
});

test('cookie recente é reaproveitado sem ping', async () => {
  const c = novoCliente();
  c._cookie = 'JSESSIONIDSSO=atual';
  c._cookieAt = Date.now();
  c._sessaoViva = async () => { throw new Error('não deveria pingar'); };

  assert.equal(await c.login(), 'JSESSIONIDSSO=atual');
});
