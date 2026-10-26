#!/usr/bin/env node
/**
 * Linha de comando sobre o mesmo cliente que o servidor MCP usa.
 *
 * Serve para conferir credencial e conectividade antes de ligar o servidor MCP num agente, e para
 * despejar datasets, formulários e definições de processo em disco.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { FluigClient } from '../src/client.js';

const OUT_DIR = process.env.FLUIG_OUT_DIR || join(process.cwd(), 'out');

const USAGE = `fluig-cli — opera o TOTVS Fluig pelo terminal

  fluig-cli ping                                Confere credencial e sessão
  fluig-cli dataset list [filtro]               Lista datasets
  fluig-cli dataset get <datasetId>             Fonte de um dataset customizado   -> datasets/
  fluig-cli dataset run <nome> [--limit N] [--fields a,b]
                                                Executa; --limit corta o que é impresso -> datasets-run/
  fluig-cli form list [filtro]                  Lista formulários
  fluig-cli form events <documentId>            Eventos do formulário             -> forms/<id>/events/
  fluig-cli form get <documentId> [versão]      Arquivos + eventos                -> forms/<id>/
  fluig-cli globalevent list                    Lista os eventos globais
  fluig-cli process versions <processId>        Versões de um processo
  fluig-cli process events <processId> [versão] Eventos do processo, lidos do XML -> processes/<id>/events/
  fluig-cli process export <processId> [versão] XML da definição                  -> processes/
  fluig-cli workflow check                      O FluiggersWidget (opcional) está instalado?

Opções (em qualquer posição):
  --env teste|prod   Ambiente (padrão: teste)

Os caminhos depois de -> são relativos a ./out (ou a FLUIG_OUT_DIR).

Ambiente: FLUIG_HOST, FLUIG_USER e FLUIG_PASS ou FLUIG_PASS_CMD; com --env prod, FLUIG_HOST_PROD,
FLUIG_USER_PROD e FLUIG_PASS_PROD ou FLUIG_PASS_CMD_PROD. Veja README.md e .env.example.`;

function print(x) {
  console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
}

// Na saída de erro, para não misturar com o que o comando imprime no stdout.
function salvar(saida, relativo, conteudo) {
  const arquivo = join(saida, relativo);
  mkdirSync(dirname(arquivo), { recursive: true });
  writeFileSync(arquivo, conteudo, 'utf8');
  console.error(`  -> gravado: ${arquivo}`);
}

function salvarEventos(saida, pasta, eventos, campo) {
  for (const e of eventos) salvar(saida, `${pasta}/${e.eventId}.js`, e[campo] || '');
}

// Opções que levam valor.
const OPCOES = ['--env', '--limit', '--fields'];

/** Separa opções de posicionais. Erro aqui acontece antes do loadConfig: sem comando de senha, sem rede. */
function lerArgs(argv) {
  const opcoes = {};
  const posicionais = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (!OPCOES.includes(argv[i])) {
      posicionais.push(argv[i]);
      continue;
    }
    const valor = argv[i + 1];
    if (valor === undefined || valor.startsWith('--')) throw new Error(`${argv[i]} precisa de um valor.`);
    opcoes[argv[i].slice(2)] = valor;
    i += 1;
  }
  const [grupo, acao, ...args] = posicionais;
  return { grupo, acao, args, opcoes };
}

/** Cada comando recebe o cliente já autenticável e { args, opcoes, saida }. */
export const COMANDOS = {
  async ping(client) {
    print(await client.ping() ? 'OK — autenticado, sessão válida.' : 'FALHOU.');
  },

  async 'dataset list'(client, { args }) {
    const filtro = (args[0] || '').toLowerCase();
    const todos = await client.listDatasets();
    const linhas = todos
      .filter((d) => !filtro || `${d.datasetId} ${d.datasetDescription || ''}`.toLowerCase().includes(filtro))
      .map((d) => `${(d.type || '').padEnd(8)} ${d.datasetId}`);
    print(linhas.join('\n'));
    console.error(`\n(${linhas.length} de ${todos.length} datasets)`);
  },

  async 'dataset get'(client, { args, saida }) {
    const id = args[0];
    const ds = await client.getCustomDataset(id);
    if (ds.datasetImpl === undefined) {
      print(ds);
      return;
    }
    salvar(saida, `datasets/${id}.js`, ds.datasetImpl);
    print(ds.datasetImpl);
  },

  async 'dataset run'(client, { args, opcoes, saida }) {
    const nome = args[0];
    const limite = Number(opcoes.limit || 0);
    const fields = (opcoes.fields || '').split(',').map((s) => s.trim()).filter(Boolean);
    const { columns, values } = await client.runDataset(nome, { fields });
    salvar(saida, `datasets-run/${nome}.json`, JSON.stringify({ columns, total: values.length, values }, null, 2));
    print({ columns, total: values.length, sample: limite > 0 ? values.slice(0, limite) : values });
  },

  async 'form list'(client, { args }) {
    const filtro = (args[0] || '').toLowerCase();
    const forms = await client.listForms();
    const linhas = forms
      .filter((f) => !filtro || `${f.documentId} ${f.documentDescription || ''} ${f.datasetName || ''}`.toLowerCase().includes(filtro))
      .map((f) => `${String(f.documentId).padEnd(9)} v${f.version}  ${f.documentDescription}  [ds:${f.datasetName || '-'}]`);
    print(linhas.join('\n'));
    console.error(`\n(${linhas.length} de ${forms.length} formulários)`);
  },

  async 'form events'(client, { args, saida }) {
    const documentId = Number(args[0]);
    const eventos = await client.getFormEvents(documentId);
    salvarEventos(saida, `forms/${documentId}/events`, eventos, 'eventDescription');
    print(eventos.map((e) => `${e.eventId} (${(e.eventDescription || '').length} caracteres)`).join('\n') || '(sem eventos)');
  },

  async 'form get'(client, { args, saida }) {
    const documentId = Number(args[0]);
    const versao = Number(args[1] || 1000);
    const nomes = await client.getFormFileNames(documentId);
    for (const nome of nomes) {
      const b64 = await client.getFormFileBase64(documentId, versao, nome);
      if (b64) salvar(saida, `forms/${documentId}/${nome}`, Buffer.from(b64, 'base64').toString('utf8'));
    }
    const eventos = await client.getFormEvents(documentId);
    salvarEventos(saida, `forms/${documentId}/events`, eventos, 'eventDescription');
    print({ files: nomes, events: eventos.map((e) => e.eventId) });
  },

  async 'globalevent list'(client) {
    const eventos = await client.listGlobalEvents();
    print(Array.isArray(eventos) ? eventos.map((e) => e.globalEventPK?.eventId).join('\n') : eventos);
  },

  async 'process versions'(client, { args }) {
    print(await client.listProcessVersions(args[0]));
  },

  async 'process events'(client, { args, saida }) {
    const processId = args[0];
    const eventos = await client.getProcessEventsFromXml(processId, args[1] ? Number(args[1]) : undefined);
    salvarEventos(saida, `processes/${processId}/events`, eventos, 'code');
    print(eventos.map((e) => `${e.eventId} (${(e.code || '').length} caracteres)`).join('\n') || '(sem eventos)');
  },

  async 'process export'(client, { args, saida }) {
    const processId = args[0];
    const xml = await client.exportProcessXml(processId, args[1] ? Number(args[1]) : undefined);
    salvar(saida, `processes/${processId}.ecm30.xml`, xml);
    console.error(`(${xml.length} caracteres)`);
  },

  async 'workflow check'(client) {
    print(await client.hasFluiggersWidget()
      ? 'FluiggersWidget INSTALADO.'
      : 'FluiggersWidget NÃO instalado — use "process events" ou as ferramentas fluig_process_*_xml.');
  },
};

function falhar(mensagem) {
  console.error(`fluig-cli: ${mensagem}`);
  process.exitCode = 1;
}

async function main(argv) {
  let pedido;
  try {
    pedido = lerArgs(argv);
  } catch (err) {
    falhar(err.message);
    return;
  }
  const { grupo, acao, args, opcoes } = pedido;
  if (!grupo || grupo === 'help' || argv.includes('--help') || argv.includes('-h')) {
    print(USAGE);
    return;
  }
  // Ajuda e comando desconhecido saem ANTES do loadConfig: ele roda FLUIG_PASS_CMD, que abre o cofre (às
  // vezes com prompt do keychain) só para o comando acabar num erro de digitação.
  const chave = `${grupo} ${acao ?? ''}`.trim();
  if (!Object.hasOwn(COMANDOS, chave)) {
    falhar(`comando desconhecido: "${chave}".\n\n${USAGE}`);
    return;
  }

  let client;
  try {
    client = new FluigClient(loadConfig(opcoes.env ?? 'teste'));
  } catch (err) {
    falhar(err.message);
    return;
  }
  await COMANDOS[chave](client, { args, opcoes, saida: OUT_DIR });
}

// Roda só como programa; importado (pelos testes), apenas expõe as funções. realpath dos dois lados
// porque, pelo atalho do npm (node_modules/.bin/fluig-cli), o argv[1] é um link para este arquivo.
function chamadoDireto() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (chamadoDireto()) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`fluig-cli: ${err?.message || err}`);
    process.exit(1);
  });
}
