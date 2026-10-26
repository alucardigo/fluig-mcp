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

const PAGINA_SAML = '\n<html xmlns="http://www.w3.org/1999/xhtml"><body onload="document.forms[0].submit()">'
  + '<form action="https://x.fluigidentity.com/cloudpass/SPInitPost/receiveSSORequest/1" method="post">'
  + '<input type="hidden" name="SAMLRequest" value="abc"/></form></body></html>';

/** Substituto mínimo de uma Response do fetch. */
function resposta(status, text, { contentType = '', setCookie = [] } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    headers: {
      get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null),
      getSetCookie: () => setCookie,
    },
  };
}

/**
 * Liga o cliente a um servidor falso. O login.do é REAL (o `login()` do cliente roda de
 * verdade) e emite JSESSIONIDSSO=s1, s2...; as demais rotas respondem, em ordem, com
 * `respostas`. Tudo que o cliente pede fica registrado em `chamadas`.
 */
function servidorFalso(c, respostas) {
  const srv = { logins: 0, chamadas: [] };
  c._fetch = async (path, opts = {}) => {
    if (path === '/portal/api/servlet/login.do') {
      srv.logins++;
      return resposta(302, '', { setCookie: [`JSESSIONIDSSO=s${srv.logins}; Path=/`] });
    }
    srv.chamadas.push({ path, method: opts.method, body: opts.body, cookie: opts.headers?.Cookie,
      contentType: opts.headers?.['Content-Type'] });
    const r = respostas.shift();
    if (!r) throw new Error(`chamada inesperada: ${path}`);
    return r;
  };
  return srv;
}

test('reconhece sessão expirada por 401, desvio SAML e página de login', () => {
  assert.equal(sessaoExpirada(401, ''), true);
  assert.equal(sessaoExpirada(200, PAGINA_SAML), true);
  assert.equal(sessaoExpirada(200, '<html><head><title>Login</title></head></html>'), true);
  assert.equal(sessaoExpirada(200, '<form action="j_security_check"><input name="j_username"></form>'), true);
});

test('dados da aplicação com as palavras-chave NÃO contam como sessão expirada', () => {
  assert.equal(sessaoExpirada(200, '{"content":[]}'), false);
  assert.equal(sessaoExpirada(200, '{"obs":"name=\\"SAMLRequest\\" fluigidentity.com"}', 'application/json'), false);
  assert.equal(sessaoExpirada(200, '<?xml version="1.0"?><e>name="j_username" SAMLRequest</e>', 'application/xml'), false);
  assert.equal(sessaoExpirada(200, 'texto com <title>Login</title> no meio'), false);
  assert.equal(sessaoExpirada(403, '<html>FortiGuard Web Filter Violation</html>'), false);
});

test('REST com sessão expirada loga de novo e repete a MESMA requisição uma vez', async () => {
  const c = novoCliente();
  const srv = servidorFalso(c, [resposta(200, PAGINA_SAML, { contentType: 'text/html' }), resposta(200, '{"ok":true}')]);

  assert.deepEqual(await c._rest('/api/x', { method: 'POST', body: '{"a":1}' }), { ok: true });
  assert.equal(srv.logins, 2);
  assert.equal(srv.chamadas.length, 2);
  assert.deepEqual(srv.chamadas.map(x => x.cookie), ['JSESSIONIDSSO=s1', 'JSESSIONIDSSO=s2']);
  for (const ch of srv.chamadas) {
    assert.deepEqual([ch.path, ch.method, ch.body, ch.contentType], ['/api/x', 'POST', '{"a":1}', 'application/json']);
  }
  assert.equal(c._cookie, 'JSESSIONIDSSO=s2', 'o cookie expirado não fica em memória');
});

test('sessão que continua expirada após o novo login é devolvida, sem laço de login', async () => {
  const c = novoCliente();
  const srv = servidorFalso(c, [resposta(200, PAGINA_SAML), resposta(200, PAGINA_SAML)]);

  const r = await c._rest('/api/x');
  assert.equal(r._status, 200);
  assert.match(r._raw, /SAMLRequest/);
  assert.equal(srv.logins, 2, 'só um novo login por chamada (protege o lockout do AD)');
  assert.equal(srv.chamadas.length, 2, 'a requisição original e UMA repetição');
});

test('REST cru também loga de novo e repete a MESMA requisição uma vez', async () => {
  const c = novoCliente();
  const srv = servidorFalso(c, [resposta(401, ''), resposta(200, '<xml/>', { contentType: 'application/xml' })]);

  const r = await c._restRaw('/api/x', { method: 'PUT', body: '<a/>', contentType: 'application/xml' });
  assert.equal(r.status, 200);
  assert.equal(r.text, '<xml/>');
  assert.equal(srv.logins, 2);
  assert.equal(srv.chamadas.length, 2);
  for (const ch of srv.chamadas) {
    assert.deepEqual([ch.path, ch.method, ch.body, ch.contentType], ['/api/x', 'PUT', '<a/>', 'application/xml']);
  }
});

test('chamadas simultâneas com a sessão expirada compartilham UM novo login', async () => {
  const c = novoCliente();
  const srv = servidorFalso(c, [
    resposta(200, PAGINA_SAML), resposta(200, PAGINA_SAML),
    resposta(200, '{"n":1}'), resposta(200, '{"n":2}'),
  ]);

  const [a, b] = await Promise.all([c._rest('/api/a'), c._rest('/api/b')]);
  assert.ok(a.n && b.n);
  assert.equal(srv.logins, 2, 'login inicial + UM novo login, não um por chamada');
  assert.deepEqual(srv.chamadas.slice(2).map(x => x.cookie), ['JSESSIONIDSSO=s2', 'JSESSIONIDSSO=s2']);
});

test('descartar uma sessão já substituída preserva a sessão nova', () => {
  const c = novoCliente();
  c._cookie = 'JSESSIONIDSSO=nova';
  c._cookieAt = Date.now();
  c._soap = { '/webdesk/X?wsdl': { client: {}, cookie: 'JSESSIONIDSSO=nova' } };

  c._descartarSessao('JSESSIONIDSSO=velha');
  assert.equal(c._cookie, 'JSESSIONIDSSO=nova');
  assert.equal(Object.keys(c._soap).length, 1);

  c._descartarSessao('JSESSIONIDSSO=nova');
  assert.equal(c._cookie, null);
  assert.deepEqual(c._soap, {});
});

test('ping com sessão expirada loga de novo e repete uma vez', async () => {
  const c = novoCliente();
  const srv = servidorFalso(c, [resposta(200, PAGINA_SAML), resposta(200, 'pong')]);

  assert.equal(await c.ping(), true);
  assert.equal(srv.logins, 2);
  assert.equal(srv.chamadas.length, 2);
});

test('cookie parado é revalidado e trocado quando o ping falha', async () => {
  const c = novoCliente();
  c._cookie = 'JSESSIONIDSSO=antigo';
  c._cookieAt = Date.now() - 60 * 60_000;
  c._soap = { '/webdesk/X?wsdl': { client: {}, cookie: 'JSESSIONIDSSO=antigo' } };
  c._sessaoViva = async () => false;
  const srv = servidorFalso(c, []);

  assert.equal(await c.login(), 'JSESSIONIDSSO=s1');
  assert.equal(srv.logins, 1);
  assert.deepEqual(c._soap, {}, 'clientes SOAP com o cookie antigo são descartados');
});

test('cookie recente é reaproveitado sem ping', async () => {
  const c = novoCliente();
  c._cookie = 'JSESSIONIDSSO=atual';
  c._cookieAt = Date.now();
  c._sessaoViva = async () => { throw new Error('não deveria pingar'); };

  assert.equal(await c.login(), 'JSESSIONIDSSO=atual');
});

test('cliente SOAP em cache só é reaproveitado com o cookie atual', async () => {
  const c = novoCliente();
  const cliente = { nome: 'em cache' };
  c._cookie = 'JSESSIONIDSSO=atual';
  c._cookieAt = Date.now();
  c._soap = { '/webdesk/X?wsdl': { client: cliente, cookie: 'JSESSIONIDSSO=atual' } };
  assert.equal(await c._soapClient('/webdesk/X?wsdl'), cliente);

  // Cookie trocado (novo login): o cliente antigo leva o cookie velho no header e é recriado.
  c._soap = { '/webdesk/X?wsdl': { client: cliente, cookie: 'JSESSIONIDSSO=velho' } };
  c._liveBase = async () => { throw new Error('recriando o cliente SOAP'); };
  await assert.rejects(() => c._soapClient('/webdesk/X?wsdl'), /recriando o cliente SOAP/);
});
