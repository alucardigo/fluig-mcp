import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FluigClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';

const LOGIN = '/portal/api/servlet/login.do';
const ROTA = '/ecm/api/rest/ecm/globalevent/deleteGlobalEvent';
const LISTA = '/ecm/api/rest/ecm/globalevent/getEventList';
const SALVAR = '/ecm/api/rest/ecm/globalevent/saveEventList';

/** Cliente offline com configuração de homologação. Quem chama define o `_fetch`. */
function clienteOffline() {
  return new FluigClient(loadConfig('teste', {
    FLUIG_HOST: 'http://fluig.exemplo.com.br:8080',
    FLUIG_USER: 'fulano',
    FLUIG_PASS: 'senha-homolog',
    FLUIG_USERCODE: 'fulano',
  }));
}

/** Resposta do login.do: emite o cookie de SSO, que é o que o cliente espera. */
const LOGIN_OK = {
  status: 302, ok: false, text: async () => '',
  headers: { get: () => null, getSetCookie: () => ['JSESSIONIDSSO=s1; Path=/'] },
};

/**
 * Cliente offline. O login.do é simulado e qualquer outra rota responde com `resposta`. Tudo que sai do
 * cliente fica em `todas`, login incluso.
 */
function clienteComFetch(resposta) {
  const c = clienteOffline();
  const todas = [];
  c._fetch = async (path, opts = {}) => {
    todas.push({ path, method: opts.method ?? 'GET' });
    if (path === LOGIN) return LOGIN_OK;
    return resposta;
  };
  return { c, todas };
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

/**
 * Servidor de eventos globais em memória, com a lista inteira como o Fluig a guarda: a leitura devolve o
 * estado do momento da chamada, o save regrava a lista que recebe e o delete tira um evento.
 *
 * `respostaDelete` troca a resposta do DELETE (e então o evento não sai da lista). Em
 * `segurarProximaLeitura()`, a próxima leitura fica pendente até `liberar()`: é o que reproduz a corrida
 * do save, que lê, outra escrita conclui, e só depois regrava a lista que leu.
 */
function servidorDeEventos(eventos, { respostaDelete } = {}) {
  let estado = eventos.map(([eventId, code]) => ({ globalEventPK: { companyId: 1, eventId }, eventDescription: code }));
  const apagados = [];
  let retencao = null;
  const c = clienteOffline();
  c._fetch = async (path, opts = {}) => {
    if (path === LOGIN) return LOGIN_OK;
    if (path === LISTA) {
      const foto = JSON.parse(JSON.stringify(estado));
      if (retencao) {
        const r = retencao;
        retencao = null;
        r.chegou();
        await r.liberada;
      }
      return json(200, foto);
    }
    if (path === SALVAR) {
      estado = JSON.parse(opts.body);
      return json(200, { content: 'OK' });
    }
    if (path.startsWith(ROTA)) {
      apagados.push(path);
      if (respostaDelete) return respostaDelete;
      const id = decodeURIComponent(path.split('eventName=')[1]);
      estado = estado.filter((e) => e.globalEventPK.eventId !== id);
      return json(200, { content: 'OK' });
    }
    throw new Error(`rota inesperada no teste: ${opts.method ?? 'GET'} ${path}`);
  };
  return {
    c,
    apagados: () => apagados.slice(),
    ids: () => estado.map((e) => e.globalEventPK.eventId),
    codigo: (id) => estado.find((e) => e.globalEventPK.eventId === id)?.eventDescription,
    segurarProximaLeitura() {
      let chegou;
      const chegouP = new Promise((ok) => { chegou = ok; });
      let liberar;
      const liberada = new Promise((ok) => { liberar = ok; });
      retencao = { chegou, liberada };
      return { chegou: chegouP, liberar };
    },
  };
}

test('confirm:true exclui com DELETE na rota de evento global, com o id codificado na query', async () => {
  const srv = servidorDeEventos([['before login/v2', 'codigo']]);
  await srv.c.deleteGlobalEvent('before login/v2', { confirm: true });
  assert.deepEqual(srv.apagados(), [`${ROTA}?eventName=before%20login%2Fv2`]);
});

test('sucesso é content "OK" e devolve o código apagado, para restaurar com fluig_globalevent_save', async () => {
  const srv = servidorDeEventos([['afterProcessCreate', 'codigo-antigo']]);
  const r = await srv.c.deleteGlobalEvent('afterProcessCreate', { confirm: true });
  assert.equal(r.content, 'OK');
  assert.deepEqual(r.eventoApagado, { eventId: 'afterProcessCreate', code: 'codigo-antigo' });
  assert.deepEqual(srv.ids(), []);
});

test('sem confirm:true é dry-run: mostra o código que seria apagado e não manda DELETE', async () => {
  for (const confirm of [undefined, false, 'true']) {
    const srv = servidorDeEventos([['afterProcessCreate', 'codigo-antigo']]);
    const r = await srv.c.deleteGlobalEvent('afterProcessCreate', { confirm });
    assert.equal(r.dryRun, true, `confirm=${JSON.stringify(confirm)}`);
    assert.deepEqual(r.seriaApagado, { eventId: 'afterProcessCreate', code: 'codigo-antigo' });
    assert.deepEqual(srv.apagados(), [], `confirm=${JSON.stringify(confirm)} mandou DELETE`);
    assert.deepEqual(srv.ids(), ['afterProcessCreate']);
  }
});

test('evento que não está na lista é recusado antes do DELETE', async () => {
  const srv = servidorDeEventos([['outro', 'x']]);
  await assert.rejects(() => srv.c.deleteGlobalEvent('naoExiste', { confirm: true }), /não existe/);
  assert.deepEqual(srv.apagados(), []);
});

test('lista que não pode ser lida recusa a exclusão: sem ela não há cópia do código', async () => {
  const { c, todas } = clienteComFetch(json(500, { message: 'falha de leitura' }));
  await assert.rejects(() => c.deleteGlobalEvent('afterProcessCreate', { confirm: true }), /não consegui ler a lista/);
  assert.equal(todas.filter((x) => x.method === 'DELETE').length, 0);
});

test('sem content "OK", erra com a mensagem do servidor', async () => {
  const srv = servidorDeEventos([['afterProcessCreate', 'x']], {
    respostaDelete: json(500, { message: 'Evento global inexistente' }),
  });
  await assert.rejects(() => srv.c.deleteGlobalEvent('afterProcessCreate', { confirm: true }), /Evento global inexistente/);
});

test('content que não é "OK" exato (ex.: "ok" em minúsculas) não conta como exclusão', async () => {
  // Apagar é irreversível: na dúvida, o cliente não diz que apagou.
  const srv = servidorDeEventos([['afterProcessCreate', 'x']], { respostaDelete: json(200, { content: 'ok' }) });
  await assert.rejects(() => srv.c.deleteGlobalEvent('afterProcessCreate', { confirm: true }), /não confirmou a exclusão/);
});

test('resposta que não é JSON (erro HTTP em texto) é erro, nunca sucesso', async () => {
  const srv = servidorDeEventos([['afterProcessCreate', 'x']], {
    respostaDelete: { status: 500, ok: false, text: async () => 'Erro interno', headers: { get: () => 'text/plain' } },
  });
  await assert.rejects(() => srv.c.deleteGlobalEvent('afterProcessCreate', { confirm: true }), /HTTP 500/);
});

test('um delete concluído entre a leitura e a gravação de um save não faz o evento voltar', async () => {
  const srv = servidorDeEventos([['X', 'codigo-x'], ['Y', 'codigo-y']]);
  const retencao = srv.segurarProximaLeitura();
  const salvar = srv.c.saveGlobalEvent('Y', 'codigo-y-novo');
  await retencao.chegou;
  const apagar = srv.c.deleteGlobalEvent('X', { confirm: true });
  // Sem fila, o delete concluiria aqui, enquanto o save ainda segura a lista antiga.
  await new Promise((ok) => setTimeout(ok, 30));
  retencao.liberar();
  await Promise.all([salvar, apagar]);
  assert.deepEqual(srv.ids(), ['Y']);
  assert.equal(srv.codigo('Y'), 'codigo-y-novo');
});

test('dois saves ao mesmo tempo não perdem o evento um do outro', async () => {
  const srv = servidorDeEventos([]);
  const retencao = srv.segurarProximaLeitura();
  const a = srv.c.saveGlobalEvent('A', 'codigo-a');
  await retencao.chegou;
  const b = srv.c.saveGlobalEvent('B', 'codigo-b');
  await new Promise((ok) => setTimeout(ok, 30));
  retencao.liberar();
  await Promise.all([a, b]);
  assert.deepEqual(srv.ids().sort(), ['A', 'B']);
});

test('eventId vazio ou que não é texto é recusado antes de qualquer requisição', async () => {
  for (const eventId of ['', '   ', undefined, null, 42]) {
    const { c, todas } = clienteComFetch(json(200, { content: 'OK' }));
    await assert.rejects(() => c.deleteGlobalEvent(eventId), /eventId/, String(eventId));
    assert.equal(todas.length, 0, `saiu requisição para eventId ${JSON.stringify(eventId)}`);
  }
});
