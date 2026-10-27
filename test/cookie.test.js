import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FluigClient } from '../src/client.js';
import { loadConfig, cookieDoComando } from '../src/config.js';

// Tenant com MFA ou SSO: a sessão vem pronta de um comando (FLUIG_COOKIE_CMD) e não há senha.
// Os testes usam process.execPath com -e e um script de uma linha: nada de shell, nada de rede.
const NODE = `"${process.execPath}"`;
const BASE = { FLUIG_HOST: 'http://fluig.exemplo.com.br:8080', FLUIG_USER: 'fulano', FLUIG_USERCODE: 'fulano' };

/** Comando que imprime `texto` na saída padrão. */
const imprime = (texto) => `${NODE} -e "process.stdout.write('${texto}')"`;

/** Comando que acrescenta uma linha em `arquivo` a cada execução e imprime `texto`. */
const contaExecucoes = (arquivo, texto) =>
  `${NODE} -e "require('fs').appendFileSync(process.argv[1], 'x\\n'); process.stdout.write('${texto}')" "${arquivo}"`;

/** Quantas vezes o comando de `contaExecucoes` rodou. */
const execucoes = (arquivo) => readFileSync(arquivo, 'utf8').split('\n').filter(Boolean).length;

/** Substituto mínimo de uma Response do fetch. */
function resposta(status, text, { contentType = '' } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null), getSetCookie: () => [] },
  };
}

/** Resposta de um Fluig saudável: ping responde pong e as rotas REST devolvem JSON. */
const SAUDAVEL = (path) => (path === '/portal/p/api/servlet/ping'
  ? resposta(200, 'pong')
  : resposta(200, '{"ok":true}', { contentType: 'application/json' }));

/**
 * Cliente com `_fetch` falso. Conta as requisições que saem e quantas foram para login.do, que é o
 * ponto da feature: no modo cookie, a conta NUNCA recebe uma tentativa de senha.
 */
function clienteFalso(env, responder = SAUDAVEL) {
  const c = new FluigClient(loadConfig('teste', { ...BASE, ...env }));
  const chamadas = [];
  c._fetch = async (path, opts = {}) => {
    chamadas.push({ path, cookie: opts.headers?.Cookie });
    return responder(path, opts);
  };
  return {
    c,
    chamadas,
    logins: () => chamadas.filter((x) => x.path === '/portal/api/servlet/login.do').length,
  };
}

test('cookie válido da saída vai no header Cookie e login.do nunca é chamado', async () => {
  const { c, chamadas, logins } = clienteFalso({ FLUIG_COOKIE_CMD: imprime('JSESSIONIDSSO=abc123') });
  assert.deepEqual(await c._rest('/ecm/api/rest/ecm/x'), { ok: true });
  assert.equal(logins(), 0);
  const rest = chamadas.filter((x) => x.path === '/ecm/api/rest/ecm/x');
  assert.equal(rest.length, 1);
  assert.equal(rest[0].cookie, 'JSESSIONIDSSO=abc123');
});

test('cookie configurado não exige senha, e o cliente não recebe senha', () => {
  const cfg = loadConfig('teste', { ...BASE, FLUIG_COOKIE_CMD: imprime('JSESSIONIDSSO=a') });
  assert.equal(cfg.pass, '');
  assert.equal(cfg.cookieCmd, imprime('JSESSIONIDSSO=a'));
});

test('a saída inteira conta: linhas em branco saem e as demais viram um cookie só', async () => {
  assert.equal(
    await cookieDoComando(imprime('\\n  JSESSIONIDSSO=abc\\r\\njwt.token=xyz\\n'), 'FLUIG_COOKIE_CMD'),
    'JSESSIONIDSSO=abc; jwt.token=xyz',
  );
});

test('CR ou NUL solto antes do cookie na mesma linha não gruda no cookie', async () => {
  // Um progresso ("Autenticando") impresso sem quebra de linha colava no nome do cookie: o undici recusava o
  // header e a mensagem de erro levava o valor do cookie.
  assert.equal(await cookieDoComando(imprime('Autenticando\\rJSESSIONIDSSO=abc'), 'FLUIG_COOKIE_CMD'), 'JSESSIONIDSSO=abc');
  assert.equal(await cookieDoComando(imprime('Autenticando\\0JSESSIONIDSSO=abc'), 'FLUIG_COOKIE_CMD'), 'JSESSIONIDSSO=abc');
});

test('progresso colado ao cookie não aparece em versionInfo()', async () => {
  const { c } = clienteFalso({ FLUIG_COOKIE_CMD: imprime('Autenticando\\rJSESSIONIDSSO=abc-secreto') });
  const info = await c.versionInfo();
  assert.deepEqual(info.cookies, ['JSESSIONIDSSO']);
  assert.doesNotMatch(JSON.stringify(info), /Autenticando|abc-secreto/);
});

test('header recusado pelo fetch não leva o valor do cookie para a mensagem de erro', async () => {
  // Defesa em profundidade: se uma saída escapar da limpeza, o erro do undici ainda não pode vazar o valor.
  const c = new FluigClient(loadConfig('teste', { ...BASE, FLUIG_COOKIE_CMD: imprime('JSESSIONIDSSO=a') }));
  c._liveBase = async () => ({ ip: '127.0.0.1' });
  await assert.rejects(() => c._fetch('/x', { headers: { Cookie: 'JSESSIONIDSSO=valor-secreto\0' } }), (e) =>
    /invalid header value/.test(e.message) && !/valor-secreto/.test(e.message));
});

test('falha de rede na consulta da versão não leva o cookie para servidorVersaoErro', async () => {
  const { c } = clienteFalso({ FLUIG_COOKIE_CMD: imprime('JSESSIONIDSSO=abc123-secreto') }, (p, o) => {
    if (p.includes('studioWorkflowRest')) throw new Error(`conexão recusada com ${o.headers.Cookie}`);
    return SAUDAVEL(p, o);
  });
  const info = await c.versionInfo();
  assert.equal(info.servidorVersao, null);
  assert.match(info.servidorVersaoErro, /consulta falhou/);
  assert.doesNotMatch(JSON.stringify(info), /abc123-secreto/);
});

test('comando de cookie que falha não roda de novo nesta sessão: só o reset libera outra execução', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluig-cookie-'));
  try {
    const arquivo = join(dir, 'execucoes.txt');
    const comandoQueFalha = `${NODE} -e "require('fs').appendFileSync(process.argv[1], 'x\\n'); process.exit(3)" "${arquivo}"`;
    const { c, logins } = clienteFalso({ FLUIG_COOKIE_CMD: comandoQueFalha });
    await assert.rejects(() => c.login(), /FLUIG_COOKIE_CMD: o comando falhou/);
    // Cada execução pode disparar outro desafio de MFA: a segunda chamada não pode rodar o comando.
    await assert.rejects(() => c.login(), /fluig_session_reset/);
    assert.equal(execucoes(arquivo), 1, 'o comando rodou de novo sem o reset');

    await assert.rejects(() => c.sessionReset(), /FLUIG_COOKIE_CMD: o comando falhou/);
    assert.equal(execucoes(arquivo), 2, 'o reset deveria liberar UMA execução');
    assert.equal(logins(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('o comando do cookie roda sem travar o event loop: outras tarefas andam enquanto ele espera', async () => {
  // Com execFileSync, o servidor MCP inteiro ficava parado enquanto o comando rodava.
  const { c } = clienteFalso({
    FLUIG_COOKIE_CMD: `${NODE} -e "setTimeout(() => process.stdout.write('JSESSIONIDSSO=a'), 400)"`,
  });
  let ticks = 0;
  const relogio = setInterval(() => { ticks++; }, 10);
  try {
    await c.login();
  } finally {
    clearInterval(relogio);
  }
  assert.ok(ticks >= 5, `o event loop ficou parado enquanto o comando rodava (ticks=${ticks})`);
});

test('FLUIG_COOKIE_TIMEOUT_MS limita a espera do comando, e a mensagem diz o limite', async () => {
  const { c } = clienteFalso({
    FLUIG_COOKIE_CMD: `${NODE} -e "setTimeout(() => process.stdout.write('JSESSIONIDSSO=a'), 3000)"`,
    FLUIG_COOKIE_TIMEOUT_MS: '200',
  });
  await assert.rejects(() => c.login(), /FLUIG_COOKIE_CMD: o comando falhou \(não respondeu em 200 ms/);
});

test('FLUIG_COOKIE_TIMEOUT_MS: padrão de 2 minutos, e valor que não é inteiro positivo é erro', () => {
  const cmd = imprime('JSESSIONIDSSO=a');
  assert.equal(loadConfig('teste', { ...BASE, FLUIG_COOKIE_CMD: cmd }).cookieTimeoutMs, 120000);
  assert.equal(loadConfig('teste', { ...BASE, FLUIG_COOKIE_CMD: cmd, FLUIG_COOKIE_TIMEOUT_MS: '5000' }).cookieTimeoutMs, 5000);
  for (const ruim of ['abc', '0', '-5', '1.5']) {
    assert.throws(
      () => loadConfig('teste', { ...BASE, FLUIG_COOKIE_CMD: cmd, FLUIG_COOKIE_TIMEOUT_MS: ruim }),
      /FLUIG_COOKIE_TIMEOUT_MS/,
      ruim,
    );
  }
});

test('saída sem cookie de sessão é erro, e a saída não aparece na mensagem', async () => {
  const { c, logins, chamadas } = clienteFalso({ FLUIG_COOKIE_CMD: imprime('segredo-sem-cookie') });
  await assert.rejects(() => c.login(), (e) =>
    /o comando não devolveu cookie de sessão/.test(e.message) && !/segredo-sem-cookie/.test(e.message));
  assert.equal(logins(), 0);
  assert.equal(chamadas.length, 0);
});

test('saída vazia também é erro, sem login.do', async () => {
  const { c, logins } = clienteFalso({ FLUIG_COOKIE_CMD: imprime('') });
  await assert.rejects(() => c.login(), /o comando não devolveu cookie de sessão/);
  assert.equal(logins(), 0);
});

test('comando que falha não cai para login.do e não manda requisição nenhuma', async () => {
  const { c, logins, chamadas } = clienteFalso({ FLUIG_COOKIE_CMD: `${NODE} -e "process.exit(3)"` });
  await assert.rejects(() => c.login(), /FLUIG_COOKIE_CMD: o comando falhou/);
  assert.equal(logins(), 0);
  assert.equal(chamadas.length, 0);
});

test('o stderr de um comando que falha não expõe o cookie', async () => {
  await assert.rejects(
    () => cookieDoComando(`${NODE} -e "process.stderr.write('JSESSIONIDSSO=vazou'); process.exit(1)"`, 'FLUIG_COOKIE_CMD'),
    (e) => /FLUIG_COOKIE_CMD/.test(e.message) && !/vazou/.test(e.message),
  );
});

test('cookie recusado: erro com a instrução de reset, sem o valor e sem rodar o comando de novo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluig-cookie-'));
  try {
    const arquivo = join(dir, 'execucoes.txt');
    const { c, logins } = clienteFalso(
      { FLUIG_COOKIE_CMD: contaExecucoes(arquivo, 'JSESSIONIDSSO=valor-secreto') },
      () => resposta(401, ''),
    );
    await assert.rejects(() => c._rest('/ecm/api/rest/ecm/x'), (e) =>
      /cookie de sessão expirado: gere outro e rode fluig_session_reset/.test(e.message)
      && !/valor-secreto/.test(e.message));
    assert.equal(logins(), 0);
    assert.equal(execucoes(arquivo), 1, 'o comando roda uma vez nesta chamada, não duas');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cookie parado que o ping recusa: erro com a instrução de reset, sem rodar o comando de novo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluig-cookie-'));
  try {
    const arquivo = join(dir, 'execucoes.txt');
    let ping = SAUDAVEL;
    const { c, logins } = clienteFalso({ FLUIG_COOKIE_CMD: contaExecucoes(arquivo, 'JSESSIONIDSSO=velho') }, (p, o) => ping(p, o));
    await c.login();
    assert.equal(execucoes(arquivo), 1);
    c._cookieAt = 0; // parado além da janela: o próximo login revalida com um ping
    ping = () => resposta(401, '');
    await assert.rejects(() => c.login(), (e) =>
      /cookie de sessão expirado: gere outro e rode fluig_session_reset/.test(e.message)
      && !/velho/.test(e.message));
    assert.equal(execucoes(arquivo), 1);
    assert.equal(logins(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fluig_session_reset roda o FLUIG_COOKIE_CMD de novo e a sessão volta a funcionar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluig-cookie-'));
  try {
    const arquivo = join(dir, 'execucoes.txt');
    let resp = () => resposta(401, '');
    const { c, logins } = clienteFalso({ FLUIG_COOKIE_CMD: contaExecucoes(arquivo, 'JSESSIONIDSSO=novo') }, (p, o) => resp(p, o));
    await assert.rejects(() => c._rest('/ecm/api/rest/ecm/x'), /cookie de sessão expirado/);
    assert.equal(execucoes(arquivo), 1);

    resp = SAUDAVEL; // o operador gerou outro cookie e chama o reset
    const reset = await c.sessionReset();
    assert.equal(execucoes(arquivo), 2);
    assert.deepEqual(reset.cookiesAgora, ['JSESSIONIDSSO']);
    assert.deepEqual(await c._rest('/ecm/api/rest/ecm/x'), { ok: true });
    assert.equal(logins(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fluig_version mostra só os NOMES dos cookies, nunca o valor', async () => {
  const { c } = clienteFalso({ FLUIG_COOKIE_CMD: imprime('JSESSIONIDSSO=abc123-secreto') });
  const info = await c.versionInfo();
  assert.deepEqual(info.cookies, ['JSESSIONIDSSO']);
  assert.doesNotMatch(JSON.stringify(info), /abc123-secreto/);
});

test('operação SOAP é recusada no modo cookie, antes de rodar o comando e de qualquer chamada', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluig-cookie-'));
  try {
    const arquivo = join(dir, 'execucoes.txt');
    const { c, logins, chamadas } = clienteFalso({ FLUIG_COOKIE_CMD: contaExecucoes(arquivo, 'JSESSIONIDSSO=a') });
    // SOAP leva usuário e senha no corpo: com senha vazia, cada chamada seria uma tentativa de login.
    await assert.rejects(() => c.listDatasets(), /indisponível com FLUIG_COOKIE_CMD/);
    assert.equal(logins(), 0);
    assert.equal(chamadas.length, 0);
    assert.equal(existsSync(arquivo) ? execucoes(arquivo) : 0, 0, 'o comando não deveria rodar para uma operação recusada');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('o cookie de homologação não vale para produção, e produção aceita o seu próprio', () => {
  const PROD = { FLUIG_HOST_PROD: 'https://fluig.exemplo.com.br:8443', FLUIG_USER_PROD: 'fulano' };
  assert.throws(() => loadConfig('prod', { ...PROD, FLUIG_COOKIE_CMD: imprime('JSESSIONIDSSO=a') }), /FLUIG_COOKIE_CMD_PROD/);
  const cfg = loadConfig('prod', { ...PROD, FLUIG_COOKIE_CMD_PROD: imprime('jwt.token=p') });
  assert.equal(cfg.pass, '');
  assert.equal(cfg.cookieCmd, imprime('jwt.token=p'));
});

test('cookie junto com senha é erro explícito: a senha nunca seria usada', () => {
  assert.throws(
    () => loadConfig('teste', { ...BASE, FLUIG_PASS: 'x', FLUIG_COOKIE_CMD: imprime('JSESSIONIDSSO=a') }),
    /FLUIG_COOKIE_CMD/,
  );
  assert.throws(
    () => loadConfig('teste', { ...BASE, FLUIG_PASS_CMD: imprime('x'), FLUIG_COOKIE_CMD: imprime('JSESSIONIDSSO=a') }),
    /FLUIG_COOKIE_CMD/,
  );
});

test('sem cookie nem senha, a falta cita também FLUIG_COOKIE_CMD_PROD', () => {
  const env = { FLUIG_HOST_PROD: 'https://x:8443', FLUIG_USER_PROD: 'fulano' };
  assert.throws(() => loadConfig('prod', env), (e) =>
    /FLUIG_PASS_PROD \(ou FLUIG_PASS_CMD_PROD\)/.test(e.message) && /FLUIG_COOKIE_CMD_PROD/.test(e.message));
});

test('FLUIG_COOKIE_CMD com aspas sem fechar é erro na carga da configuração', () => {
  assert.throws(() => loadConfig('teste', { ...BASE, FLUIG_COOKIE_CMD: 'pass show "fluig' }), /aspas/);
});
