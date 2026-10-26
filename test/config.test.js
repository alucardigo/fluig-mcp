import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ambientesConfigurados } from '../src/config.js';

const HOMOLOG = {
  FLUIG_HOST: 'http://fluig.exemplo.com.br:8080',
  FLUIG_USER: 'fulano',
  FLUIG_PASS: 'senha-homolog',
};
const PROD = {
  FLUIG_HOST_PROD: 'https://fluig.exemplo.com.br:8443',
  FLUIG_USER_PROD: 'fulano',
  FLUIG_PASS_PROD: 'senha-prod',
};

test('falha explicitamente quando falta variável, em vez de usar default', () => {
  assert.throws(() => loadConfig('teste', {}), /não configurado/i);
  assert.throws(() => loadConfig('teste', { FLUIG_HOST: 'http://x:8080' }), /FLUIG_USER/);
});

test('a mensagem de erro diz exatamente o que falta', () => {
  try {
    loadConfig('prod', { FLUIG_HOST_PROD: 'https://x:8443' });
    assert.fail('deveria ter lançado');
  } catch (e) {
    assert.match(e.message, /FLUIG_USER_PROD/);
    assert.match(e.message, /FLUIG_PASS_PROD/);
  }
});

test('NÃO existe host nem senha embutidos no código', async () => {
  const fonte = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8'));
  // Um default de host ou senha seria um vazamento: o teste existe para que ninguém
  // reintroduza um por conveniência.
  assert.doesNotMatch(fonte, /FLUIG_HOST\s*\|\|\s*['"]http/i, 'host default reintroduzido');
  assert.doesNotMatch(fonte, /FLUIG_PASS\s*\|\|\s*['"][^'"]+['"]/, 'senha default reintroduzida');
});

test('a senha de PRODUÇÃO não cai na de homologação', () => {
  // Esse fallback existia e queimava tentativas do AD contra produção.
  assert.throws(() => loadConfig('prod', { ...HOMOLOG, FLUIG_HOST_PROD: 'https://p:8443', FLUIG_USER_PROD: 'fulano' }),
    /FLUIG_PASS_PROD/);
});

test('lê os dois ambientes de forma independente', () => {
  const t = loadConfig('teste', { ...HOMOLOG, ...PROD });
  const p = loadConfig('prod', { ...HOMOLOG, ...PROD });
  assert.equal(t.env, 'teste');
  assert.equal(t.isProd, false);
  assert.equal(t.host, 'http://fluig.exemplo.com.br:8080');
  assert.equal(p.env, 'prod');
  assert.equal(p.isProd, true);
  assert.equal(p.pass, 'senha-prod');
  assert.notEqual(t.pass, p.pass);
});

test('recusa host que não é URL http(s)', () => {
  assert.throws(() => loadConfig('teste', { ...HOMOLOG, FLUIG_HOST: 'nao-e-url' }), /não é uma URL válida/i);
  assert.throws(() => loadConfig('teste', { ...HOMOLOG, FLUIG_HOST: 'ftp://x' }), /http ou https/i);
});

test('remove barra final do host', () => {
  const c = loadConfig('teste', { ...HOMOLOG, FLUIG_HOST: 'http://fluig.exemplo.com.br:8080//' });
  assert.equal(c.host, 'http://fluig.exemplo.com.br:8080');
});

test('recusa ambiente inválido', () => {
  assert.throws(() => loadConfig('producao', HOMOLOG), /Ambiente inválido/i);
});

test('ambientesConfigurados enxerga só o que tem host', () => {
  assert.deepEqual(ambientesConfigurados({}), []);
  assert.deepEqual(ambientesConfigurados(HOMOLOG), ['teste']);
  assert.deepEqual(ambientesConfigurados({ ...HOMOLOG, ...PROD }), ['teste', 'prod']);
});

test('FLUIG_READONLY aceita as formas usuais de "sim"', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
    assert.equal(loadConfig('teste', { ...HOMOLOG, FLUIG_READONLY: v }).readOnly, true, v);
  }
  for (const v of ['0', 'false', '', 'nao']) {
    assert.equal(loadConfig('teste', { ...HOMOLOG, FLUIG_READONLY: v }).readOnly, false, v);
  }
});

// ---------- FLUIG_PASS_CMD: senha vinda de um comando (cofre do sistema), não do JSON do cliente ----------
const NODE = `"${process.execPath}"`;
const BASE = { FLUIG_HOST: 'http://fluig.exemplo.com.br:8080', FLUIG_USER: 'fulano' };

test('dividirComando respeita aspas e não usa shell', async () => {
  const { dividirComando } = await import('../src/config.js');
  assert.deepEqual(dividirComando(`secret-tool lookup service "fluig prod" user 'fu lano'`),
    ['secret-tool', 'lookup', 'service', 'fluig prod', 'user', 'fu lano']);
  assert.throws(() => dividirComando('pass show "fluig'), /aspas/);
});

test('FLUIG_PASS_CMD fornece a senha (sem a quebra de linha final)', () => {
  const cfg = loadConfig('teste', { ...BASE, FLUIG_PASS_CMD: `${NODE} -e "process.stdout.write('s3nha\\n')"` });
  assert.equal(cfg.pass, 's3nha');
});

test('FLUIG_PASS e FLUIG_PASS_CMD juntos é erro explícito', () => {
  assert.throws(
    () => loadConfig('teste', { ...BASE, FLUIG_PASS: 'x', FLUIG_PASS_CMD: `${NODE} -e "1"` }),
    /FLUIG_PASS.*FLUIG_PASS_CMD|não os dois/,
  );
});

test('comando que falha ou não imprime nada é erro antes de qualquer login', () => {
  assert.throws(() => loadConfig('teste', { ...BASE, FLUIG_PASS_CMD: `${NODE} -e "process.exit(3)"` }), /FLUIG_PASS_CMD/);
  assert.throws(() => loadConfig('teste', { ...BASE, FLUIG_PASS_CMD: `${NODE} -e "1"` }), /FLUIG_PASS_CMD.*vazia/);
});

test('produção usa FLUIG_PASS_CMD_PROD, e a falta de senha cita as duas opções', () => {
  const env = { FLUIG_HOST_PROD: 'https://x:8443', FLUIG_USER_PROD: 'fulano' };
  assert.throws(() => loadConfig('prod', env), /FLUIG_PASS_PROD \(ou FLUIG_PASS_CMD_PROD\)/);
  const cfg = loadConfig('prod', { ...env, FLUIG_PASS_CMD_PROD: `${NODE} -e "process.stdout.write('p')"` });
  assert.equal(cfg.pass, 'p');
});

// Convenção do pass/gopass: a senha é a PRIMEIRA linha; as seguintes são metadados (login:, url:).
// Mandar a saída inteira como senha gasta uma das tentativas do AD com a senha errada.
test('FLUIG_PASS_CMD usa só a primeira linha da saída', () => {
  const senhaDe = (js) => loadConfig('teste', { ...BASE, FLUIG_PASS_CMD: `${NODE} -e "${js}"` }).pass;
  assert.equal(senhaDe(`process.stdout.write('s3nha\\nlogin: fulano\\nurl: x\\n')`), 's3nha');
  assert.equal(senhaDe(`process.stdout.write('s3nha\\r\\nlogin: fulano\\r\\n')`), 's3nha');
  assert.equal(senhaDe(`process.stdout.write('s3nha\\n\\n')`), 's3nha');
});

test('FLUIG_PASS_CMD com a primeira linha vazia é erro antes do login', () => {
  assert.throws(
    () => loadConfig('teste', { ...BASE, FLUIG_PASS_CMD: `${NODE} -e "process.stdout.write('\\ns3nha\\n')"` }),
    /FLUIG_PASS_CMD.*vazia/,
  );
});

test('FLUIG_PASS_CMD que falha mostra o stderr (cortado), nunca o stdout', () => {
  const erroDe = (js) => {
    try {
      loadConfig('teste', { ...BASE, FLUIG_PASS_CMD: `${NODE} -e "${js}"` });
    } catch (e) {
      return e.message;
    }
    assert.fail('deveria ter lançado');
  };
  assert.match(erroDe(`process.stderr.write('vault locked'); process.exit(1)`), /vault locked/);
  // Um comando que imprimiu a senha e depois falhou: o stdout é a própria senha.
  assert.doesNotMatch(erroDe(`process.stdout.write('SEGREDO'); process.exit(2)`), /SEGREDO/);
  const longo = erroDe(`process.stderr.write('x'.repeat(5000)); process.exit(1)`);
  assert.ok(longo.length < 400, `mensagem com ${longo.length} caracteres`);
});

test('FLUIG_PASS_CMD com saída fora de UTF-8 é erro antes do login', () => {
  // 0x87 0xC6 é "çã" no code page 850 (PowerShell 5.1 no Windows pt-BR): virariam U+FFFD e o
  // login iria com a senha errada.
  assert.throws(
    () => loadConfig('teste', { ...BASE, FLUIG_PASS_CMD: `${NODE} -e "process.stdout.write(Buffer.from([0x53,0x87,0xc6]))"` }),
    /FLUIG_PASS_CMD.*UTF-8/,
  );
});

test('no Windows, .cmd sem shell vira erro com a dica do .exe/powershell', { skip: process.platform !== 'win32' }, async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'fluig-pass-cmd-'));
  try {
    const cmd = join(dir, 'senha.cmd');
    writeFileSync(cmd, '@echo s3nha\r\n');
    assert.throws(() => loadConfig('teste', { ...BASE, FLUIG_PASS_CMD: `"${cmd}"` }), /powershell/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--help e a falta de ambiente citam FLUIG_PASS_CMD e FLUIG_SAIDA_DIR', async () => {
  const { execFileSync } = await import('node:child_process');
  const server = new URL('../server.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const limpo = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const help = execFileSync(process.execPath, [server, '--help'], { encoding: 'utf8', env: limpo });
  assert.match(help, /FLUIG_PASS_CMD\b/);
  assert.match(help, /FLUIG_PASS_CMD_PROD/);
  assert.match(help, /FLUIG_SAIDA_DIR/);
  assert.throws(
    () => execFileSync(process.execPath, [server], { encoding: 'utf8', timeout: 15000, env: limpo }),
    (e) => /nenhum ambiente configurado/i.test(String(e.stderr)) && /FLUIG_PASS_CMD/.test(String(e.stderr)),
  );
});

test('senha ausente e credencial recusada citam também FLUIG_PASS_CMD', async () => {
  const { FluigClient } = await import('../src/client.js');
  const cfg = { host: 'http://fluig.exemplo.com.br:8080', user: 'fulano', userCode: 'fulano', companyId: 1, seedIps: [] };
  await assert.rejects(() => new FluigClient({ ...cfg, pass: '' }).login(), /FLUIG_PASS_CMD/);
  const c = new FluigClient({ ...cfg, pass: 'errada' });
  c._fetch = async () => ({ status: 200, headers: { getSetCookie: () => [] }, text: async () => '{}' });
  await assert.rejects(() => c.login(), (e) => /credencial recusada/.test(e.message) && /FLUIG_PASS_CMD/.test(e.message));
});
