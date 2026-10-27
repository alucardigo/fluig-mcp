import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FluigClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';

const ROTA_VERSAO = '/ecm/api/rest/ecm/studioWorkflowRest/version';
const HOST = 'http://fluig.exemplo.com.br:8080';

/** Cliente apontado para um host que nunca é contatado: os testes daqui ficam offline. */
function novoCliente() {
  return new FluigClient(loadConfig('teste', {
    FLUIG_HOST: HOST,
    FLUIG_USER: 'fulano',
    FLUIG_PASS: 'senha-homolog',
    FLUIG_USERCODE: 'fulano',
  }));
}

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
 * Servidor falso para o diagnóstico. login.do emite um cookie novo a cada chamada e user-info
 * responde um usuário válido. Só a rota de versão consome `respostas`, em ordem: cada item é uma
 * Response ou um Error (falha de rede, que o fetch lança).
 */
function servidorComVersao(c, respostas) {
  const srv = { logins: 0, chamadasVersao: [] };
  c._fetch = async (path, opts = {}) => {
    if (path === '/portal/api/servlet/login.do') {
      srv.logins++;
      return resposta(302, '', { setCookie: [`JSESSIONIDSSO=s${srv.logins}; Path=/`] });
    }
    if (path === '/authentication/api/v1/login/user-info') {
      return resposta(200, '{"code":"fulano","id":7}', { contentType: 'application/json' });
    }
    srv.chamadasVersao.push({ path, method: opts.method });
    const r = respostas.shift();
    if (!r) throw new Error(`chamada inesperada: ${path}`);
    if (r instanceof Error) throw r;
    return r;
  };
  return srv;
}

test('versionInfo traz a versão do servidor Fluig e mantém o diagnóstico que já existia', async () => {
  const c = novoCliente();
  const srv = servidorComVersao(c, [resposta(200, '{"version":"1.7.0"}', { contentType: 'application/json' })]);

  const info = await c.versionInfo();

  assert.equal(info.servidorVersao, '1.7.0');
  assert.equal(info.servidorVersaoErro, null);
  assert.deepEqual(srv.chamadasVersao, [{ path: ROTA_VERSAO, method: 'GET' }]);
  assert.equal(info.host, HOST);
  assert.equal(info.colleagueId, 'fulano');
  assert.equal(info.usuario.code, 'fulano');
  assert.ok(info.cookies.includes('JSESSIONIDSSO'));
});

test('a versão é o primeiro x.y.z do corpo, mesmo quando há outros números', async () => {
  const c = novoCliente();
  servidorComVersao(c, [resposta(200, 'Fluig 2.0.1 (build 1.2.3)', { contentType: 'text/plain' })]);

  const info = await c.versionInfo();

  assert.equal(info.servidorVersao, '2.0.1');
  assert.equal(info.servidorVersaoErro, null);
});

test('corpo sem número de versão devolve erro curto, e não uma versão inventada', async () => {
  const c = novoCliente();
  servidorComVersao(c, [resposta(200, '{"ok":true,"build":45}', { contentType: 'application/json' })]);

  const info = await c.versionInfo();

  assert.equal(info.servidorVersao, null);
  assert.match(info.servidorVersaoErro, /sem número de versão/);
});

test('corpo HTML não conta como versão, mesmo trazendo um x.y.z dentro da página', async () => {
  const c = novoCliente();
  servidorComVersao(c, [resposta(200, '\n<html><body>Painel 9.9.9</body></html>', { contentType: 'text/html' })]);

  const info = await c.versionInfo();

  assert.equal(info.servidorVersao, null);
  assert.match(info.servidorVersaoErro, /HTML/);
  assert.ok(info.servidorVersaoErro.length <= 80, `erro longo demais: ${info.servidorVersaoErro}`);
});

test('erro 500 da rota de versão não vira versão, mesmo com x.y.z no corpo do erro', async () => {
  const c = novoCliente();
  servidorComVersao(c, [resposta(500, 'erro interno na versão 1.2.3', { contentType: 'text/plain' })]);

  const info = await c.versionInfo();

  assert.equal(info.servidorVersao, null);
  assert.equal(info.servidorVersaoErro, 'HTTP 500');
});

test('falha de rede na consulta da versão não derruba o diagnóstico', async () => {
  const c = novoCliente();
  servidorComVersao(c, [new Error('fetch failed')]);

  const info = await c.versionInfo();

  assert.equal(info.servidorVersao, null);
  assert.match(info.servidorVersaoErro, /fetch failed/);
  assert.ok(info.servidorVersaoErro.length <= 120, `erro longo demais: ${info.servidorVersaoErro}`);
  assert.equal(info.host, HOST, 'o resto do diagnóstico continua vindo');
});

test('401 repetido depois do novo login vira erro curto, e o login não se repete em laço', async () => {
  const c = novoCliente();
  const srv = servidorComVersao(c, [resposta(401, ''), resposta(401, '')]);

  const info = await c.versionInfo();

  assert.equal(info.servidorVersao, null);
  assert.match(info.servidorVersaoErro, /sessão expirada/);
  assert.ok(info.servidorVersaoErro.length <= 120, `erro longo demais: ${info.servidorVersaoErro}`);
  assert.equal(srv.logins, 2, 'login inicial + UM novo login, como as demais chamadas REST');
  assert.equal(srv.chamadasVersao.length, 2, 'a requisição e UMA repetição');
});
