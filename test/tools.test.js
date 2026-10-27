import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = new URL('../server.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FONTE = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

/**
 * Servidor MCP de verdade, falando stdio, apontado para um Fluig falso que só conta requisições.
 * `fluig.requisicoes === 0` prova que a recusa aconteceu antes de qualquer coisa sair da máquina.
 * `ambiente` acrescenta variáveis ao do servidor; valor null tira a variável.
 */
async function conectar(t, ambiente = {}) {
  const fluig = { requisicoes: 0, exclusoes: 0 };
  const http = createServer((req, res) => {
    fluig.requisicoes++;
    if (req.method === 'DELETE') fluig.exclusoes++;
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Fluig falso');
  });
  await new Promise((ok) => http.listen(0, '127.0.0.1', ok));
  const host = `http://127.0.0.1:${http.address().port}`;
  const saida = mkdtempSync(join(tmpdir(), 'tools-saida-'));
  const credencial = (sufixo) => ({
    [`FLUIG_HOST${sufixo}`]: host, [`FLUIG_USER${sufixo}`]: 'fulano',
    [`FLUIG_PASS${sufixo}`]: 'senha', [`FLUIG_USERCODE${sufixo}`]: 'fulano',
  });
  const env = { ...credencial(''), ...credencial('_PROD'), FLUIG_SAIDA_DIR: saida, ...ambiente };
  for (const [k, v] of Object.entries(env)) if (v === null) delete env[k];
  const mcp = new Client({ name: 'tools-test', version: '0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'ignore' }));
  t.after(async () => {
    await mcp.close();
    http.closeAllConnections();
    http.close();
    rmSync(saida, { recursive: true, force: true });
  });
  const chamar = async (name, args) => {
    const r = await mcp.callTool({ name, arguments: args });
    return { erro: r.isError === true, texto: r.content.map((c) => c.text).join('\n') };
  };
  return { mcp, fluig, saida, chamar };
}

/** As doze escritas que até a 1.1.0 rodavam sem confirm, com argumentos mínimos válidos. */
const CONFIRM_EM_PROD = {
  fluig_dataset_save: { datasetId: 'ds_x', code: 'function createDataset() {}' },
  fluig_dataset_enable: { datasetId: 'ds_x', ativo: true },
  fluig_globalevent_save: { eventId: 'afterProcessCreate', code: 'function afterProcessCreate() {}' },
  fluig_workflow_events_update: { processId: 'ZZ_TESTE', version: 1, events: [] },
  fluig_form_save: { documentId: 1, datasetName: 'ds_form', cardDescription: 'x', files: [] },
  fluig_process_start: { processId: 'ZZ_TESTE', choosedState: 2 },
  fluig_process_move: { processInstanceId: 1, choosedState: 2 },
  fluig_process_take: { processInstanceId: 1 },
  fluig_rest_post: { path: '/api/public/2.0/x', body: '{}' },
  fluig_job_add: { description: 'x', expression: '0 00 02 1/1 * ? *', jobType: 1 },
  fluig_job_delete: { jobId: 'x', jobType: 23 },
  fluig_job_run: { jobId: 'x', jobType: 23 },
};

/** Roda o servidor em modo listagem, com ambiente controlado. */
function listar(env = {}) {
  return execFileSync(process.execPath, [SERVER, '--list'], {
    encoding: 'utf8',
    // Ambiente limpo de propósito: listar NÃO pode depender de credencial.
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
  });
}

const nomes = (saida) => saida.split('\n')
  .map((l) => l.match(/^\s*!?\s*(fluig_[a-z_0-9]+):/)).filter(Boolean).map((m) => m[1]);

test('--list roda sem nenhuma credencial', () => {
  const saida = listar();
  assert.match(saida, /fluig-mcp .* ferramentas/);
  assert.ok(nomes(saida).length > 50, 'deveria listar a superfície inteira');
});

test('modo somente leitura esconde TODA ferramenta de escrita', () => {
  const completo = nomes(listar());
  const somenteLeitura = nomes(listar({ FLUIG_READONLY: '1' }));
  assert.ok(somenteLeitura.length < completo.length, 'readonly deveria reduzir a lista');
  // A marcação `!` é o contrato visual de "isto altera o servidor".
  assert.doesNotMatch(listar({ FLUIG_READONLY: '1' }), /^\s*!\s/m, 'vazou ferramenta de escrita');
});

test('confirm e escrita andam juntos: toda escrita declara confirm, e só escrita declara', async (t) => {
  // Lido do schema que o cliente MCP recebe, não do fonte: é ele que diz ao agente o que mandar.
  // A marca `!` do --list sai de TOOLS_ESCRITA, a lista curada (heurística por nome errou nos dois sentidos).
  const escrita = new Set(listar().split('\n').map((l) => l.match(/^\s*!\s*(fluig_[a-z_0-9]+):/)?.[1]).filter(Boolean));
  const { mcp } = await conectar(t);
  const { tools } = await mcp.listTools();
  const comConfirm = new Set(tools.filter((x) => x.inputSchema.properties?.confirm?.type === 'boolean').map((x) => x.name));

  assert.ok(escrita.size > 30, `a marca ! sumiu do --list (achou ${escrita.size})`);
  const semConfirm = [...escrita].filter((n) => !comConfirm.has(n));
  assert.deepEqual(semConfirm, [], `escrita sem confirm no schema: ${semConfirm.join(', ')}`);
  const confirmEmLeitura = [...comConfirm].filter((n) => !escrita.has(n));
  assert.deepEqual(confirmEmLeitura, [], `confirm em ferramenta fora de TOOLS_ESCRITA: ${confirmEmLeitura.join(', ')}`);
});

test('em produção, as doze escritas sem confirm são recusadas antes de qualquer requisição', async (t) => {
  const { fluig, chamar } = await conectar(t);
  for (const [nome, args] of Object.entries(CONFIRM_EM_PROD)) {
    for (const confirm of [undefined, false]) {
      const r = await chamar(nome, { env: 'prod', ...args, confirm });
      assert.ok(r.erro, `${nome} (confirm=${confirm}) deveria ser recusada`);
      assert.match(r.texto, new RegExp(`${nome} .*PRODUÇÃO.*exige confirm:true`), nome);
    }
  }
  assert.equal(fluig.requisicoes, 0, 'nenhuma chamada recusada pode chegar ao servidor');
});

test('chamada recusada por confirm não roda o comando da senha (FLUIG_PASS_CMD_PROD)', async (t) => {
  // O loadConfig executa o comando do cofre ao criar o cliente do ambiente. Uma escrita que vai ser
  // recusada não pode disparar o cofre (prompt, efeito colateral, erro do comando no lugar do de confirm).
  const dir = mkdtempSync(join(tmpdir(), 'tools-cofre-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marca = join(dir, 'cofre-rodou');
  const cofre = join(dir, 'cofre.mjs');
  writeFileSync(cofre, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marca)}, 'x');\nconsole.log('senha');\n`);
  const { fluig, chamar } = await conectar(t, {
    FLUIG_PASS_PROD: null, FLUIG_PASS_CMD_PROD: `"${process.execPath}" "${cofre}"`,
  });

  const args = CONFIRM_EM_PROD.fluig_dataset_save;
  assert.match((await chamar('fluig_dataset_save', { env: 'prod', ...args })).texto, /exige confirm:true/);
  assert.match((await chamar('fluig_dataset_delete', { env: 'prod', datasetId: 'ds_x', confirm: 'false' })).texto,
    /confirm precisa ser booleano/);
  assert.equal(existsSync(marca), false, 'o comando da senha rodou para uma chamada recusada');
  assert.equal(fluig.requisicoes, 0);

  // Prova de que o teste enxerga o cofre: a chamada confirmada o executa.
  await chamar('fluig_dataset_save', { env: 'prod', ...args, confirm: true });
  assert.equal(existsSync(marca), true);
});

test('em homologação as mesmas escritas passam sem confirm, e confirm:true libera a produção', async (t) => {
  const { fluig, chamar } = await conectar(t);
  const teste = await chamar('fluig_dataset_save', { env: 'teste', ...CONFIRM_EM_PROD.fluig_dataset_save });
  assert.doesNotMatch(teste.texto, /confirm/, 'homologação não pede confirm');
  const antes = fluig.requisicoes;
  assert.ok(antes > 0, 'a chamada de homologação deveria ter chegado ao servidor');

  const prod = await chamar('fluig_rest_post', { env: 'prod', ...CONFIRM_EM_PROD.fluig_rest_post, confirm: true });
  assert.doesNotMatch(prod.texto, /confirm/);
  assert.ok(fluig.requisicoes > antes, 'com confirm:true a chamada de produção segue para o servidor');
});

test('apagar evento global sem confirm é dry-run: nenhum DELETE sai, em homologação nem em produção', async (t) => {
  // Apagar leva o código do evento junto. Sem confirm:true a ferramenta só lê e mostra o que seria apagado,
  // como fluig_process_convert_instances. O fake aqui não serve a leitura, então o retorno pode ser erro:
  // o que importa é que nenhum DELETE chegue ao Fluig. O formato do dry-run é coberto em test/globalevent.test.js.
  const { fluig, chamar } = await conectar(t);
  for (const env of ['teste', 'prod']) {
    for (const confirm of [undefined, false]) {
      const r = await chamar('fluig_globalevent_delete', { env, eventId: 'afterProcessCreate', confirm });
      // O despacho não recusa mais antes do handler: quem decide entre dry-run e exclusão é a ferramenta.
      assert.doesNotMatch(r.texto, /exige confirm/, `${env} confirm=${confirm}: o despacho recusou antes do dry-run`);
    }
  }
  assert.equal(fluig.exclusoes, 0, 'uma exclusão sem confirm chegou ao servidor');

  await chamar('fluig_globalevent_delete', { env: 'teste', eventId: 'afterProcessCreate', confirm: true });
  assert.ok(fluig.requisicoes > 0, 'com confirm:true a exclusão segue para o servidor');
});

test('confirm que não é booleano é recusado em toda ferramenta, em vez de virar true por !!', async (t) => {
  // "false" é string não vazia: `!!confirm` a tomava por confirmação.
  const { fluig, chamar } = await conectar(t);
  for (const [nome, args] of [
    ['fluig_dataset_delete', { datasetId: 'ds_x' }],
    ['fluig_dataset_save', CONFIRM_EM_PROD.fluig_dataset_save],
  ]) {
    for (const env of ['teste', 'prod']) {
      const r = await chamar(nome, { env, ...args, confirm: 'false' });
      assert.ok(r.erro, `${nome} em ${env}`);
      assert.match(r.texto, /confirm precisa ser booleano/, `${nome} em ${env}`);
    }
  }
  assert.equal(fluig.requisicoes, 0);
});

test('fluig_deploy_process só lê xmlPath e svgPath de dentro da pasta de saída', async (t) => {
  const { fluig, saida, chamar } = await conectar(t);
  const fora = mkdtempSync(join(tmpdir(), 'tools-fora-'));
  t.after(() => rmSync(fora, { recursive: true, force: true }));
  writeFileSync(join(fora, 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----');
  const base = { env: 'teste', confirm: true, processId: 'ZZ_TESTE' };

  for (const args of [
    { xmlPath: join(fora, 'id_rsa') },
    { xmlPath: '../id_rsa' },
    { xml: '<list/>', svgPath: join(fora, 'id_rsa') },
  ]) {
    const r = await chamar('fluig_deploy_process', { ...base, ...args });
    assert.ok(r.erro, JSON.stringify(args));
    assert.match(r.texto, /(xmlPath|svgPath) fora da pasta de saída/, JSON.stringify(args));
    assert.doesNotMatch(r.texto, /OPENSSH/);
  }
  assert.equal(fluig.requisicoes, 0, 'arquivo de fora não pode ser lido nem enviado');

  // Dentro da pasta (relativo a ela) a leitura acontece e o deploy segue para o servidor.
  mkdirSync(join(saida, 'proc'));
  writeFileSync(join(saida, 'proc', 'ZZ_TESTE.ecm30.xml'), '<list><ProcessDefinition/></list>');
  const r = await chamar('fluig_deploy_process', { ...base, xmlPath: 'proc/ZZ_TESTE.ecm30.xml' });
  assert.doesNotMatch(r.texto, /fora da pasta|ENOENT/);
  assert.ok(fluig.requisicoes > 0);
});

test('toda ferramenta exige o parâmetro env', () => {
  // Sem isso, uma chamada sem `env` cairia num ambiente default e leria homologação
  // achando que era produção — o erro que motivou tornar `env` obrigatório.
  const semEnv = FONTE.includes("t.inputSchema.required = [...new Set([...(t.inputSchema.required || []), 'env'])]");
  assert.ok(semEnv, 'a injeção de `env` como obrigatório sumiu do server.js');
});

test('subir sem ambiente configurado falha com mensagem útil', () => {
  assert.throws(
    () => execFileSync(process.execPath, [SERVER], {
      encoding: 'utf8', timeout: 15000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }),
    (e) => {
      assert.match(String(e.stderr), /nenhum ambiente configurado/i);
      assert.match(String(e.stderr), /FLUIG_HOST/);
      return true;
    },
  );
});

test('--help e --version não exigem credencial', () => {
  const limpo = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const help = execFileSync(process.execPath, [SERVER, '--help'], { encoding: 'utf8', env: limpo });
  assert.match(help, /FLUIG_READONLY/);
  const v = execFileSync(process.execPath, [SERVER, '--version'], { encoding: 'utf8', env: limpo });
  assert.match(v.trim(), /^\d+\.\d+\.\d+$/);
});
