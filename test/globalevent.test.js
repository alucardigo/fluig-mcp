import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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

/**
 * Fluig falso em HTTP de verdade, com a lista em memória. O primeiro DELETE apaga o evento e fecha o socket
 * sem responder: é a queda de conexão depois de o servidor já ter feito o trabalho. Os DELETE seguintes
 * respondem como um Fluig que não acha mais o evento.
 */
async function fluigQueCaiNoPrimeiroDelete(t, eventos) {
  let estado = eventos.map(([eventId, code]) => ({ globalEventPK: { companyId: 1, eventId }, eventDescription: code }));
  let deletes = 0;
  const http = createServer((req, res) => {
    const url = new URL(req.url, 'http://fluig.exemplo.com.br');
    const enviar = (status, corpo) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(corpo));
    };
    if (req.method === 'POST' && url.pathname === LOGIN) {
      res.writeHead(302, { 'Set-Cookie': 'JSESSIONIDSSO=s1; Path=/' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === LISTA) return enviar(200, estado);
    if (req.method === 'DELETE' && url.pathname === ROTA) {
      deletes++;
      const id = url.searchParams.get('eventName');
      const existia = estado.some((e) => e.globalEventPK.eventId === id);
      estado = estado.filter((e) => e.globalEventPK.eventId !== id);
      if (deletes === 1) return req.socket.destroy();
      if (!existia) return enviar(500, { message: { message: 'Evento global inexistente' } });
      return enviar(200, { content: 'OK' });
    }
    enviar(404, { message: { message: `rota inesperada no teste: ${req.method} ${url.pathname}` } });
  });
  await new Promise((ok) => http.listen(0, '127.0.0.1', ok));
  t.after(() => {
    http.closeAllConnections();
    http.close();
  });
  const c = new FluigClient(loadConfig('teste', {
    FLUIG_HOST: `http://127.0.0.1:${http.address().port}`,
    FLUIG_USER: 'fulano',
    FLUIG_PASS: 'senha-homolog',
    FLUIG_USERCODE: 'fulano',
  }));
  return { c, deletes: () => deletes };
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
  // Formato real do Fluig: a mensagem vem aninhada em message.message.
  const { c, todas } = clienteComFetch(json(500, { message: { message: 'falha de leitura' } }));
  await assert.rejects(() => c.deleteGlobalEvent('afterProcessCreate', { confirm: true }), (e) =>
    /não consegui ler a lista/.test(e.message) && /falha de leitura/.test(e.message) && !/\[object Object\]|HTTP \?/.test(e.message));
  assert.equal(todas.filter((x) => x.method === 'DELETE').length, 0);
});

test('sem content "OK", erra com a mensagem do servidor, sem "[object Object]" no lugar do texto', async () => {
  const srv = servidorDeEventos([['afterProcessCreate', 'x']], {
    respostaDelete: json(500, { message: { message: 'Evento global inexistente' } }),
  });
  await assert.rejects(() => srv.c.deleteGlobalEvent('afterProcessCreate', { confirm: true }), (e) =>
    /Evento global inexistente/.test(e.message) && !/\[object Object\]/.test(e.message));
});

test('resposta sem "OK" que não tira o evento da lista é erro, com o código antes de apagar na mensagem', async () => {
  // Se o código sumisse aqui, a única cópia dele se perderia: o erro tem que trazê-lo.
  const html = {
    status: 200,
    ok: true,
    text: async () => '<html><body>Erro interno</body></html>',
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html' : null) },
  };
  for (const respostaDelete of [json(200, { content: 'Success' }), html]) {
    const srv = servidorDeEventos([['afterProcessCreate', 'codigo-antigo-unico']], { respostaDelete });
    await assert.rejects(() => srv.c.deleteGlobalEvent('afterProcessCreate', { confirm: true }), (e) =>
      /não confirmou a exclusão/.test(e.message) && e.message.includes('Código antes de apagar: codigo-antigo-unico'));
    assert.deepEqual(srv.ids(), ['afterProcessCreate']);
  }
});

test('resposta sem "OK" depois de o evento já ter saído da lista: a exclusão aconteceu, e o código volta', async () => {
  const srv = servidorDeEventos([['afterProcessCreate', 'codigo-antigo']]);
  const porDentro = srv.c._fetch;
  srv.c._fetch = async (path, opts = {}) => {
    if (!path.startsWith(ROTA)) return porDentro(path, opts);
    await porDentro(path, opts); // o servidor apaga de fato...
    return json(500, { message: { message: 'resposta perdida' } }); // ...e a resposta se perde
  };
  const r = await srv.c.deleteGlobalEvent('afterProcessCreate', { confirm: true });
  assert.deepEqual(r.eventoApagado, { eventId: 'afterProcessCreate', code: 'codigo-antigo' });
  assert.match(r.aviso, /não confirmou a exclusão/);
  assert.deepEqual(srv.ids(), []);
});

test('se a lista não puder ser relida depois da falha do DELETE, erra com o código e não diz que apagou', async () => {
  const srv = servidorDeEventos([['afterProcessCreate', 'codigo-sem-leitura']], {
    respostaDelete: json(500, { message: { message: 'Erro do servidor' } }),
  });
  const porDentro = srv.c._fetch;
  let leituras = 0;
  srv.c._fetch = async (path, opts = {}) => {
    // A primeira leitura é a de _eventoGlobal, antes do DELETE; a segunda é a conferência depois da falha.
    if (path === LISTA && ++leituras > 1) return json(500, { message: { message: 'lista indisponível' } });
    return porDentro(path, opts);
  };
  await assert.rejects(() => srv.c.deleteGlobalEvent('afterProcessCreate', { confirm: true }), (e) =>
    /Erro do servidor/.test(e.message)
    && /não consegui reler a lista/.test(e.message)
    && e.message.includes('Código antes de apagar: codigo-sem-leitura')
    && !e.message.includes('a exclusão aconteceu'));
});

test('DELETE que cai na rede depois de o servidor apagar: não repete o DELETE e confere a lista', async (t) => {
  // A repetição mandaria um segundo DELETE, que o servidor recusa como "não existe", e a cópia do código se
  // perderia. Com uma só tentativa e a releitura, o resultado é sucesso com o código devolvido.
  const srv = await fluigQueCaiNoPrimeiroDelete(t, [['afterProcessCreate', 'codigo-antigo']]);
  const r = await srv.c.deleteGlobalEvent('afterProcessCreate', { confirm: true });
  assert.equal(srv.deletes(), 1, 'o DELETE foi repetido depois da queda da conexão');
  assert.deepEqual(r.eventoApagado, { eventId: 'afterProcessCreate', code: 'codigo-antigo' });
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
