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
