import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FluigClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';

const LOGIN = '/portal/api/servlet/login.do';
const ROTA = '/ecm/api/rest/ecm/globalevent/deleteGlobalEvent';

/**
 * Cliente offline. O login.do é simulado (emite o cookie de SSO) e qualquer outra rota responde com
 * `resposta`. Tudo que sai do cliente fica em `todas`, login incluso.
 */
function clienteComFetch(resposta) {
  const c = new FluigClient(loadConfig('teste', {
    FLUIG_HOST: 'http://fluig.exemplo.com.br:8080',
    FLUIG_USER: 'fulano',
    FLUIG_PASS: 'senha-homolog',
    FLUIG_USERCODE: 'fulano',
  }));
  const todas = [];
  c._fetch = async (path, opts = {}) => {
    todas.push({ path, method: opts.method ?? 'GET' });
    if (path === LOGIN) {
      return { status: 302, ok: false, text: async () => '',
        headers: { get: () => null, getSetCookie: () => ['JSESSIONIDSSO=s1; Path=/'] } };
    }
    return resposta;
  };
  return { c, todas, exclusoes: () => todas.filter((x) => x.path !== LOGIN) };
}

/** Resposta JSON, no formato do fetch (text + headers). */
function json(status, corpo) {
  const text = JSON.stringify(corpo);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
  };
}

test('exclui com DELETE na rota de evento global, com o id codificado na query', async () => {
  const { c, exclusoes } = clienteComFetch(json(200, { content: 'OK' }));
  await c.deleteGlobalEvent('before login/v2');
  assert.deepEqual(exclusoes(), [{
    path: `${ROTA}?eventName=before%20login%2Fv2`,
    method: 'DELETE',
  }]);
});

test('sucesso é content "OK": devolve a resposta do servidor', async () => {
  const { c } = clienteComFetch(json(200, { content: 'OK' }));
  assert.deepEqual(await c.deleteGlobalEvent('afterProcessCreate'), { content: 'OK' });
});

test('sem content "OK", erra com a mensagem do servidor', async () => {
  const { c } = clienteComFetch(json(500, { message: 'Evento global inexistente' }));
  await assert.rejects(() => c.deleteGlobalEvent('naoExiste'), /Evento global inexistente/);
});

test('content que não é "OK" exato (ex.: "ok" em minúsculas) não conta como exclusão', async () => {
  // Apagar é irreversível: na dúvida, o cliente não diz que apagou.
  const { c } = clienteComFetch(json(200, { content: 'ok' }));
  await assert.rejects(() => c.deleteGlobalEvent('afterProcessCreate'), /não confirmou a exclusão/);
});

test('resposta que não é JSON (erro HTTP em texto) é erro, nunca sucesso', async () => {
  const { c } = clienteComFetch({
    status: 500, ok: false, text: async () => 'Erro interno', headers: { get: () => 'text/plain' },
  });
  await assert.rejects(() => c.deleteGlobalEvent('afterProcessCreate'), /HTTP 500/);
});

test('eventId vazio ou que não é texto é recusado antes de qualquer requisição', async () => {
  for (const eventId of ['', '   ', undefined, null, 42]) {
    const { c, todas } = clienteComFetch(json(200, { content: 'OK' }));
    await assert.rejects(() => c.deleteGlobalEvent(eventId), /eventId/, String(eventId));
    assert.equal(todas.length, 0, `saiu requisição para eventId ${JSON.stringify(eventId)}`);
  }
});
