import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FluigClient, sessaoExpirada } from '../src/client.js';
import { loadConfig } from '../src/config.js';

/**
 * Cliente apontado para um host que nunca é contatado: os testes daqui ficam offline.
 * FLUIG_USERCODE definido desliga a descoberta do colleagueId pela sessão (user-info), que é
 * coberta em userCode.test.js; aqui o servidor falso só precisa responder às rotas da sessão.
 */
function novoCliente() {
  return new FluigClient(loadConfig('teste', {
    FLUIG_HOST: 'http://fluig.exemplo.com.br:8080',
    FLUIG_USER: 'fulano',
    FLUIG_PASS: 'senha-homolog',
    FLUIG_USERCODE: 'fulano',
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

// Fluig sem Fluig Identity, medido em homologação com cookie inválido: as rotas REST v2 respondem
// 401, mas as antigas /ecm/api/rest/ecm/* (loadDataset, getEventList, createDataset, editDataset)
// respondem 500 com o "Login failed" do Undertow — que precisa contar como sessão expirada.
const LOGIN_FAILED_UNDERTOW = '{"content":"ERROR","message":{"message":"UT010031: Login failed",'
  + '"detail":"UT010031: Login failed","type":"ERROR"}}';

test('500 com o "Login failed" do Undertow (UT010031) conta como sessão expirada', () => {
  assert.equal(sessaoExpirada(500, LOGIN_FAILED_UNDERTOW, 'application/json'), true);
  // Um 500 qualquer, ou o código citado num 200 de dados, NÃO conta.
  assert.equal(sessaoExpirada(500, '{"code":"javax.ejb.EJBException"}', 'application/json'), false);
  assert.equal(sessaoExpirada(200, '{"obs":"UT010031: Login failed"}', 'application/json'), false);
});

test('rota antiga /ecm/api/rest com UT010031 loga de novo e repete uma vez', async () => {
  const c = novoCliente();
  const srv = servidorFalso(c, [
    resposta(500, LOGIN_FAILED_UNDERTOW, { contentType: 'application/json' }),
    resposta(200, '{"content":{"datasetId":"ds_x"}}', { contentType: 'application/json' }),
  ]);

  const r = await c._rest('/ecm/api/rest/ecm/dataset/loadDataset?datasetId=ds_x');
  assert.deepEqual(r, { content: { datasetId: 'ds_x' } });
  assert.equal(srv.logins, 2);
});

test('credencial recusada trava novos logins até o fluig_session_reset (protege o AD)', async () => {
  const c = novoCliente();
  let logins = 0;
  c._fetch = async (path) => {
    if (path === '/portal/api/servlet/login.do') {
      logins++;
      return resposta(200, '{}'); // 200 sem JSESSIONIDSSO = o servidor recusou a credencial
    }
    throw new Error(`chamada inesperada: ${path}`);
  };

  await assert.rejects(() => c.login(), /credencial recusada/);
  // Cada chamada de ferramenta que viesse depois tentaria de novo: 3 chamadas = conta bloqueada.
  await assert.rejects(() => c.login(), /já recusou a credencial/);
  await assert.rejects(() => c._rest('/api/x'), /já recusou a credencial/);
  assert.equal(logins, 1, 'só a primeira tentativa chega ao servidor');

  // O reset é a liberação explícita: tenta UMA vez de novo.
  await assert.rejects(() => c.sessionReset(), /credencial recusada/);
  assert.equal(logins, 2);
});

test('falha de rede no login.do NÃO trava (não é recusa de credencial)', async () => {
  const c = novoCliente();
  c._bustIp = () => {};
  let logins = 0;
  c._fetch = async (path) => {
    if (path === '/portal/api/servlet/login.do') {
      logins++;
      return resposta(403, '<html>FortiGuard Web Filter Violation</html>');
    }
    throw new Error(`chamada inesperada: ${path}`);
  };

  await assert.rejects(() => c.login(), /Falha no login \(HTTP 403\)/);
  await assert.rejects(() => c.login(), /Falha no login \(HTTP 403\)/);
  assert.equal(logins, 6, 'bloqueio de rede continua com as 3 tentativas por chamada');
});

test('REST cru que continua com a página de SSO depois do novo login é erro, nunca "200 ok"', async () => {
  // Ferramentas de escrita olham só o status do _restRaw: um 200 com a página de SSO viraria ok:true.
  const c = novoCliente();
  const srv = servidorFalso(c, [resposta(200, PAGINA_SAML), resposta(200, PAGINA_SAML)]);
  await assert.rejects(() => c._restRaw('/api/x', { method: 'PUT', body: '<a/>', contentType: 'application/xml' }),
    /sessão expirada mesmo depois de um novo login/);
  assert.equal(srv.logins, 2);
});

test('erro de rede na revalidação NÃO derruba a sessão (não é sessão morta)', async () => {
  const c = novoCliente();
  c._cookie = 'JSESSIONIDSSO=antigo';
  c._cookieAt = Date.now() - 60 * 60_000;
  const srv = servidorFalso(c, []);
  c._fetch = async (path) => {
    if (path === '/portal/api/servlet/login.do') { srv.logins++; return resposta(302, '', { setCookie: ['JSESSIONIDSSO=novo'] }); }
    throw new Error('fetch failed');
  };
  assert.equal(await c.login(), 'JSESSIONIDSSO=antigo');
  assert.equal(srv.logins, 0, 'sem resposta do servidor não dá para dizer que a sessão morreu');
});

test('fluig_session_reset durante uma revalidação em andamento faz login NOVO', async () => {
  const c = novoCliente();
  c._cookie = 'JSESSIONIDSSO=antigo';
  c._cookieAt = Date.now() - 60 * 60_000;
  let liberar;
  c._sessaoViva = () => new Promise((r) => { liberar = r; });
  const srv = servidorFalso(c, []);
  const revalidando = c.login();
  await Promise.resolve();
  const reset = c.sessionReset();
  liberar(true); // a revalidação diria que o cookie antigo ainda vale
  await revalidando;
  const r = await reset;
  assert.equal(srv.logins, 1);
  assert.deepEqual(r.cookiesAgora, ['JSESSIONIDSSO']);
  assert.equal(c._cookie, 'JSESSIONIDSSO=s1');
});

test('_sessaoViva: só rejeição definitiva de sessão é false; resposta sem pong e sem rejeição é inconclusiva (null)', async () => {
  const casos = [
    [resposta(200, 'pong'), true],
    [resposta(401, ''), false],
    [resposta(302, ''), false],
    [resposta(200, PAGINA_SAML, { contentType: 'text/html' }), false],
    [resposta(404, 'não encontrado', { contentType: 'text/plain' }), null],
    [resposta(200, 'corpo qualquer'), null],
    [resposta(503, 'indisponível'), null],
    [resposta(200, 'Web Filter Violation'), null],
  ];
  for (const [r, esperado] of casos) {
    const c = novoCliente();
    c._fetch = async () => r;
    assert.equal(await c._sessaoViva('JSESSIONIDSSO=x'), esperado, `status ${r.status}`);
  }
});

test('ping com 404 sem relação com a sessão mantém o cookie e não força novo login', async () => {
  const c = novoCliente();
  c._cookie = 'JSESSIONIDSSO=atual';
  c._cookieAt = Date.now() - 60 * 60_000; // parado além da janela: o próximo login revalida com ping
  const srv = servidorFalso(c, [resposta(404, 'não encontrado', { contentType: 'text/plain' })]);

  assert.equal(await c.login(), 'JSESSIONIDSSO=atual');
  assert.equal(srv.logins, 0, 'um ping inconclusivo não pode gastar um login');
});

test('ping redirecionado sem pong (302 para a tela de login) é sessão acabada: o login refaz a sessão', async () => {
  // Portal com SSO manda o navegador para a tela de login com um 302. Sem tratar o 3xx, o ping virava "não
  // sei" e o cookie morto seguia valendo até a próxima falha.
  const c = novoCliente();
  c._cookie = 'JSESSIONIDSSO=atual';
  c._cookieAt = Date.now() - 60 * 60_000;
  const srv = servidorFalso(c, [resposta(302, '')]);

  assert.equal(await c.login(), 'JSESSIONIDSSO=s1');
  assert.equal(srv.logins, 1, 'um 302 sem pong precisa refazer a sessão');
});

test('ping inconclusivo não renova a validade do cookie: a próxima chamada pergunta ao servidor de novo', async () => {
  const c = novoCliente();
  c._cookie = 'JSESSIONIDSSO=atual';
  c._cookieAt = Date.now() - 60 * 60_000;
  const srv = servidorFalso(c, [
    resposta(404, 'não encontrado', { contentType: 'text/plain' }),
    resposta(404, 'não encontrado', { contentType: 'text/plain' }),
  ]);

  assert.equal(await c.login(), 'JSESSIONIDSSO=atual');
  assert.equal(await c.login(), 'JSESSIONIDSSO=atual');
  assert.equal(srv.chamadas.length, 2, 'um cookie não confirmado não pode ficar válido por 20 min sem novo ping');
  assert.equal(srv.logins, 0);
});

test('updateWorkflowEvents: sessão expirada no modo cookie descarta o cookie e manda gerar outro e rodar o reset', async () => {
  const NODE = `"${process.execPath}"`;
  const c = new FluigClient(loadConfig('teste', {
    FLUIG_HOST: 'http://fluig.exemplo.com.br:8080',
    FLUIG_USER: 'fulano',
    FLUIG_USERCODE: 'fulano',
    FLUIG_COOKIE_CMD: `${NODE} -e "process.stdout.write('JSESSIONIDSSO=valor-secreto')"`,
  }));
  c._cookie = 'JSESSIONIDSSO=valor-secreto';
  c._cookieAt = Date.now();
  c._fetch = async () => resposta(401, '');

  await assert.rejects(() => c.updateWorkflowEvents('PROC', 1, []), (e) =>
    /sessão expirada: gere outro cookie e rode fluig_session_reset/.test(e.message) && !/valor-secreto/.test(e.message));
  assert.equal(c._cookie, null, 'o cookie recusado sai do cache');
  await assert.rejects(() => c.login(), /rode fluig_session_reset/, 'a orientação precisa ser verdadeira: o próximo login não roda o comando');
});

test('updateWorkflowEvents: sessão expirada no modo senha descarta o cookie e manda tentar de novo, com login automático', async () => {
  const c = novoCliente();
  c._cookie = 'JSESSIONIDSSO=valor-secreto';
  c._cookieAt = Date.now();
  const srv = servidorFalso(c, [resposta(401, '')]);

  await assert.rejects(() => c.updateWorkflowEvents('PROC', 1, []), (e) =>
    /sessão expirada: tente de novo \(o próximo login é automático\)/.test(e.message) && !/valor-secreto/.test(e.message));
  assert.equal(c._cookie, null, 'o cookie recusado sai do cache');
  assert.equal(srv.logins, 0, 'a gravação recusada não dispara login por conta própria');
  assert.equal(await c.login(), 'JSESSIONIDSSO=s1', 'o próximo login é automático');
});

test('updateWorkflowEvents: gravação aceita devolve o JSON da resposta, com PUT', async () => {
  const c = novoCliente();
  const corpo = '{"ok":true,"gravados":2}';
  // Response de verdade tem text() e json(); o mock precisa dos dois para não depender de qual o código usa.
  const ok = { ...resposta(200, corpo, { contentType: 'application/json' }), json: async () => JSON.parse(corpo) };
  const srv = servidorFalso(c, [ok]);

  assert.deepEqual(await c.updateWorkflowEvents('PROC', 1, [{ a: 1 }]), { ok: true, gravados: 2 });
  assert.equal(srv.chamadas[0].method, 'PUT');
});
