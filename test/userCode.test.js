import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { FluigClient } from '../src/client.js';

const ENV = { FLUIG_HOST: 'http://fluig.exemplo.com.br:8080', FLUIG_USER: 'fulano', FLUIG_PASS: 'segredo' };

/** Cliente com a rede simulada: login.do emite o cookie de SSO e user-info devolve `userInfo`. */
function clienteSimulado(env, userInfo) {
  const c = new FluigClient(loadConfig('teste', env));
  const chamadas = [];
  c._fetch = async (path, opts = {}) => {
    chamadas.push(path);
    if (path === '/portal/api/servlet/login.do') {
      return { status: 302, ok: false, headers: { getSetCookie: () => ['JSESSIONIDSSO=abc; Path=/'] } };
    }
    if (path === '/authentication/api/v1/login/user-info') {
      if (userInfo instanceof Error) throw userInfo;
      return { status: 200, ok: true, json: async () => userInfo };
    }
    throw new Error(`rota inesperada no teste: ${path} ${opts.method || 'GET'}`);
  };
  return { c, chamadas };
}

test('sem FLUIG_USERCODE, o colleagueId vem do code da sessão (user-info), não do login', async () => {
  const { c, chamadas } = clienteSimulado(ENV, { code: '000123', login: 'fulano', tenantId: 1 });
  await c.login();
  assert.equal(c.userCode, '000123');
  assert.deepEqual(chamadas, ['/portal/api/servlet/login.do', '/authentication/api/v1/login/user-info']);
  await c.login();
  assert.equal(chamadas.length, 2, 'a descoberta acontece uma vez só');
});

test('FLUIG_USERCODE definido tem prioridade e user-info não é chamada', async () => {
  const { c, chamadas } = clienteSimulado({ ...ENV, FLUIG_USERCODE: '999' }, { code: '000123' });
  await c.login();
  assert.equal(c.userCode, '999');
  assert.deepEqual(chamadas, ['/portal/api/servlet/login.do']);
});

test('se user-info falhar, mantém o login como código e não derruba o login', async (t) => {
  const avisos = [];
  t.mock.method(console, 'error', (msg) => avisos.push(String(msg)));
  const { c } = clienteSimulado(ENV, new Error('fetch failed'));
  assert.equal(await c.login(), 'JSESSIONIDSSO=abc');
  assert.equal(c.userCode, 'fulano');
  assert.match(avisos.join('\n'), /FLUIG_USERCODE/);
});

test('companyId -1 resolve o tenant pela sessão, sem senha na URL', async () => {
  const { c, chamadas } = clienteSimulado({ ...ENV, FLUIG_COMPANY: '-1' }, { code: '000123', tenantId: 7 });
  c._rest = async (path) => { chamadas.push(path); return { code: '000123', tenantId: 7 }; };
  assert.deepEqual(await c.resolveTenant(), { companyId: 7, colleagueId: '000123' });
  assert.ok(chamadas.every((p) => !/password=/.test(p)), `senha numa URL: ${chamadas.join(' ')}`);
});
