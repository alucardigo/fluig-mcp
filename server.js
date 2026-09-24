#!/usr/bin/env node
/**
 * MCP server para o TOTVS Fluig — dá ao Claude autonomia de administrar,
 * gerenciar e desenvolver no Fluig direto pela API (sem IDE).
 *
 * Registrar no Claude Code (~/.claude.json > mcpServers):
 *   "fluig": { "command": "node", "args": ["D:\\Dev\\fluig-mcp\\server.js"] }
 * (senha vem de src/config.js / env FLUIG_PASS). Requer restart da sessão.
 *
 * Auto-teste (sem stdio):  node server.js --list
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, ambientesConfigurados } from './src/config.js';
import { FluigClient } from './src/client.js';
import { readFileSync } from 'node:fs';

const VERSAO = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

// Um FluigClient por ambiente, criado SOB DEMANDA. Preguiçoso de propósito: `--list` e `--help`
// precisam rodar sem nenhuma credencial, para que qualquer pessoa possa auditar o que este
// servidor faz ANTES de entregar uma senha a ele. Instanciar no topo quebraria isso.
// `client` é o alvo ATIVO da chamada em curso — o dispatcher troca a referência conforme o
// `env` recebido, então todo handler que usa `client.xxx(...)` funciona sem alteração.
const clientsByEnv = {};
function clienteDe(env) {
  if (!clientsByEnv[env]) clientsByEnv[env] = new FluigClient(loadConfig(env));
  return clientsByEnv[env];
}
let client = null;

const S = (props = {}, required = []) => ({ type: 'object', properties: props, required });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

const TOOLS = [
  {
    name: 'fluig_ping',
    description: 'Testa autenticação e sessão no servidor Fluig configurado.',
    inputSchema: S(),
    handler: async () => (await client.ping()) ? 'OK — autenticado.' : 'FALHOU.',
  },
  {
    name: 'fluig_dataset_list',
    description: 'Lista datasets do servidor (id + tipo). Aceita filtro (substring em id/descrição).',
    inputSchema: S({ filtro: str('substring para filtrar (opcional)') }),
    handler: async ({ filtro }) => {
      const all = await client.listDatasets();
      const f = (filtro || '').toLowerCase();
      const rows = all
        .filter(d => !f || `${d.datasetId} ${d.datasetDescription || ''}`.toLowerCase().includes(f))
        .map(d => ({ id: d.datasetId, type: d.type }));
      return { total: all.length, matched: rows.length, datasets: rows };
    },
  },
  {
    name: 'fluig_dataset_get',
    description: 'Retorna o código-fonte de um dataset CUSTOM (loadDataset).',
    inputSchema: S({ datasetId: str('id do dataset custom') }, ['datasetId']),
    handler: async ({ datasetId }) => {
      const ds = await client.getCustomDataset(datasetId);
      return ds.datasetImpl !== undefined ? ds.datasetImpl : ds;
    },
  },
  {
    name: 'fluig_dataset_run',
    description: 'Executa um dataset (form ou custom) e retorna as linhas. fields e limit opcionais.',
    inputSchema: S({
      name: str('nome do dataset'),
      fields: { type: 'array', items: { type: 'string' }, description: 'colunas a retornar (opcional)' },
      limit: num('máximo de linhas a exibir (opcional)'),
    }, ['name']),
    handler: async ({ name, fields = [], limit = 0 }) => {
      const { columns, values } = await client.runDataset(name, { fields });
      return { columns, total: values.length, values: limit > 0 ? values.slice(0, limit) : values };
    },
  },
  {
    name: 'fluig_dataset_save',
    description: 'Cria ou atualiza (upsert) um dataset CUSTOM com o código informado.',
    inputSchema: S({
      datasetId: str('id do dataset'),
      code: str('código JS (função createDataset) — ES5/Rhino'),
      description: str('descrição (opcional)'),
    }, ['datasetId', 'code']),
    handler: async ({ datasetId, code, description }) => client.saveDataset(datasetId, code, description),
  },
  {
    name: 'fluig_form_list',
    description: 'Lista formulários (documentId, versão, descrição, dataset). Filtro opcional.',
    inputSchema: S({ filtro: str('substring para filtrar (opcional)') }),
    handler: async ({ filtro }) => {
      const forms = await client.listForms();
      const f = (filtro || '').toLowerCase();
      return forms
        .filter(x => !f || `${x.documentId} ${x.documentDescription || ''} ${x.datasetName || ''}`.toLowerCase().includes(f))
        .map(x => ({ documentId: x.documentId, version: x.version, description: x.documentDescription, dataset: x.datasetName }));
    },
  },
  {
    name: 'fluig_form_events',
    description: 'Retorna os eventos de customização de um formulário (displayFields, validateForm, etc.).',
    inputSchema: S({ documentId: num('documentId do formulário') }, ['documentId']),
    handler: async ({ documentId }) => {
      const events = await client.getFormEvents(documentId);
      return events.map(e => ({ eventId: e.eventId, code: e.eventDescription }));
    },
  },
  {
    name: 'fluig_form_files',
    description: 'Lista os nomes de arquivos (HTML/JS/CSS) de um formulário.',
    inputSchema: S({ documentId: num('documentId do formulário') }, ['documentId']),
    handler: async ({ documentId }) => client.getFormFileNames(documentId),
  },
  {
    name: 'fluig_form_file',
    description: 'Retorna o conteúdo (texto) de um arquivo específico do formulário.',
    inputSchema: S({
      documentId: num('documentId'), version: num('versão do form'), fileName: str('nome do arquivo'),
    }, ['documentId', 'version', 'fileName']),
    handler: async ({ documentId, version, fileName }) => {
      const b64 = await client.getFormFileBase64(documentId, version, fileName);
      return b64 ? Buffer.from(b64, 'base64').toString('utf8') : '(vazio)';
    },
  },
  {
    name: 'fluig_globalevent_list',
    description: 'Lista os eventos globais do servidor.',
    inputSchema: S(),
    handler: async () => {
      const ev = await client.listGlobalEvents();
      return Array.isArray(ev) ? ev.map(e => ({ eventId: e.globalEventPK?.eventId, code: e.eventDescription })) : ev;
    },
  },
  {
    name: 'fluig_globalevent_save',
    description: 'Cria ou atualiza um evento global.',
    inputSchema: S({ eventId: str('id do evento global'), code: str('código JS') }, ['eventId', 'code']),
    handler: async ({ eventId, code }) => client.saveGlobalEvent(eventId, code),
  },
  {
    name: 'fluig_workflow_check',
    description: 'Verifica se o FluiggersWidget está instalado (necessário p/ eventos de processo via API).',
    inputSchema: S(),
    handler: async () => (await client.hasFluiggersWidget())
      ? 'FluiggersWidget INSTALADO — eventos de processo disponíveis via API.'
      : 'FluiggersWidget NÃO instalado — eventos de processo indisponíveis via API.',
  },
  {
    name: 'fluig_workflow_events_get',
    description: 'Lê os eventos de um processo (requer FluiggersWidget). Use fluig_workflow_check antes.',
    inputSchema: S({ processId: str('id do processo'), version: num('versão do processo') }, ['processId', 'version']),
    handler: async ({ processId, version }) => client.getWorkflowEvents(processId, version),
  },
  {
    name: 'fluig_workflow_events_update',
    description: 'Grava eventos de um processo (requer FluiggersWidget). events = [{name, contents}].',
    inputSchema: S({
      processId: str('id do processo'), version: num('versão'),
      events: { type: 'array', items: { type: 'object' }, description: '[{name, contents}]' },
    }, ['processId', 'version', 'events']),
    handler: async ({ processId, version, events }) => client.updateWorkflowEvents(processId, version, events),
  },
  {
    name: 'fluig_form_full',
    description: 'Lê um formulário INTEIRO: metadados + todos os arquivos (texto) + eventos. Use antes de editar/publicar.',
    inputSchema: S({ documentId: num('documentId'), version: num('versão do form') }, ['documentId', 'version']),
    handler: async ({ documentId, version }) => {
      const f = await client.getFormFull(documentId, version);
      return { meta: { documentId, datasetName: f.meta.datasetName, description: f.meta.documentDescription }, files: f.files.map(x => x.fileName), events: f.events.map(e => e.eventId) };
    },
  },
  {
    name: 'fluig_form_save',
    description: 'Publica/atualiza um formulário (nova versão revertível). Manda TODOS os arquivos+eventos. files:[{fileName,content}], events:[{eventId,eventDescription}]. Faça fluig_form_full antes e altere só o que precisa.',
    inputSchema: S({
      documentId: num('documentId'),
      datasetName: str('nome do dataset do form'),
      cardDescription: str('descrição do form'),
      descriptionField: str('campo descritor (pode vazio)'),
      files: { type: 'array', items: { type: 'object' }, description: '[{fileName, content}] TODOS os arquivos' },
      events: { type: 'array', items: { type: 'object' }, description: '[{eventId, eventDescription}] TODOS os eventos' },
      versionOption: str('0=manter versão, 2=nova versão (default 2)'),
    }, ['documentId', 'datasetName', 'cardDescription', 'files']),
    handler: async ({ documentId, ...o }) => client.saveForm(documentId, { ...o, versionOption: o.versionOption || '2' }),
  },
  {
    name: 'fluig_process_event_get',
    description: 'Lê o código de um evento de PROCESSO (serviceTask/beforeTaskSave) via event_proces — sem widget.',
    inputSchema: S({ processCode: str('trecho do COD_DEF_PROCES, ex: WRH16'), eventName: str('ex: servicetask71'), version: num('NUM_VERS') }, ['processCode', 'eventName', 'version']),
    handler: async ({ processCode, eventName, version }) => (await client.getProcessEventCode(processCode, eventName, version)) || '(não encontrado)',
  },
  {
    name: 'fluig_process_event_set',
    description: '⚠️ Grava um evento de PROCESSO na event_proces (in-place, com BACKUP automático). Exige confirm=true. Use só em homolog e com consciência.',
    inputSchema: S({ processCode: str('COD_DEF_PROCES'), eventName: str('ex: servicetask71'), version: num('NUM_VERS'), code: str('novo código'), confirm: { type: 'boolean' } }, ['processCode', 'eventName', 'version', 'code', 'confirm']),
    handler: async ({ processCode, eventName, version, code, confirm }) => client.setProcessEvent(processCode, eventName, version, code, { confirm: !!confirm }),
  },
  {
    name: 'fluig_deploy_list',
    description: 'Lista os processos disponíveis para export/deploy no servidor (via SOAP WorkflowEngineService + token). Útil p/ validar o deploy e para o round-trip de validação.',
    inputSchema: S(),
    handler: async () => client.listDeployableProcesses(),
  },
  {
    name: 'fluig_deploy_process',
    description: '⚠️ DEPLOY estrutural de PROCESSO (BPMN) headless via SOAP WorkflowEngineService (importProcess+releaseProcess, token do TokenService) — SEM Fluig Studio. Publica o .ecm30.xml (<list><ProcessDefinition>…). Exige confirm=true. 1º uso: validar com round-trip (baixar um processo real e re-deployar idêntico).',
    inputSchema: S({
      xmlPath: str('caminho do arquivo .ecm30.xml (alternativa a xml)'),
      xml: str('conteúdo do .ecm30.xml inline (alternativa a xmlPath)'),
      processId: str('id do processo (opcional; extraído do XML se omitido)'),
      isNew: { type: 'boolean', description: 'true = processo novo; false (default) = nova versão de existente' },
      overWrite: { type: 'boolean', description: 'sobrescrever (default true)' },
      svgPath: str('caminho opcional do .processimage.svg'),
      confirm: { type: 'boolean' },
    }, ['confirm']),
    handler: async ({ xmlPath, xml, processId, isNew = false, overWrite = true, svgPath, confirm }) => {
      const processDefXml = xml || (xmlPath ? readFileSync(xmlPath, 'utf8') : null);
      if (!processDefXml) throw new Error('Informe xml (inline) ou xmlPath.');
      const svgXml = svgPath ? readFileSync(svgPath, 'utf8') : undefined;
      return client.deployProcess(processDefXml, { processId, isNew, overWrite, svgXml, confirm: !!confirm });
    },
  },
  {
    name: 'fluig_db_query',
    description: 'SELECT no banco do Fluig (TOTVSECM, /jdbc/AppDS). Lê qualquer tabela: event_proces '
      + '(eventos de processo, SEM widget), DEF_PROCES, FDN_*, etc. '
      + '⚠️ A CONSULTA é read-only, mas a TOOL NÃO É: para executar SQL arbitrário o Fluig exige que ele '
      + 'viva num dataset, então cada chamada grava `ds_claude_dbquery` no servidor e registra o SQL em '
      + 'FDN_DATASETHISTORY (imutável pela API). Em env="prod" exige confirm=true por causa disso.',
    inputSchema: S({
      sql: str('SELECT ... (somente SELECT/WITH)'),
      confirm: { type: 'boolean', description: 'obrigatório em env="prod": ciente de que grava dataset e histórico em produção' },
    }, ['sql']),
    handler: async ({ sql, confirm }) => {
      const r = await client.dbQuery(sql, { confirm: !!confirm });
      return { columns: r.columns, total: r.values.length, values: r.values.slice(0, 200) };
    },
  },
  {
    name: 'fluig_rm_db_query',
    description: 'SELECT DIRETO no banco do RM/Corpore (/jdbc/Corpore). Lê qualquer tabela do RM '
      + '(VPCOMPL, PFUNCAOCOMPL, PPESSOA, PFUNC, TMOV...) sem precisar de sentença WS.###. '
      + '⚠️ Mesma ressalva do fluig_db_query: a consulta é read-only, mas a tool grava '
      + '`ds_claude_rmdbquery` no servidor para executá-la. Em env="prod" exige confirm=true. '
      + 'Se existir sentença WS.### para o que você quer, prefira fluig_rm_query — essa não grava nada.',
    inputSchema: S({
      sql: str('SELECT ... (somente SELECT/WITH)'),
      confirm: { type: 'boolean', description: 'obrigatório em env="prod": ciente de que grava dataset e histórico em produção' },
    }, ['sql']),
    handler: async ({ sql, confirm }) => {
      const r = await client.rmDbQuery(sql, { confirm: !!confirm });
      return { columns: r.columns, total: r.values.length, values: r.values.slice(0, 200) };
    },
  },
  {
    name: 'fluig_rm_query',
    description: 'Consulta o RM (Corpore) pelo padrão MIP: ds_generic_rm_sql + sentença homologada WS.###. '
      + 'READ-ONLY DE VERDADE: chama o dataset direto pelo dataset-handle/search, sem gravar nada no '
      + 'servidor. É o caminho preferido para ler o RM — use no lugar de fluig_rm_db_query sempre que '
      + 'houver sentença. Informe os campos esperados.',
    inputSchema: S({
      codSentenca: str('ex: WS.247'),
      fields: { type: 'array', items: { type: 'string' }, description: 'colunas esperadas da sentença' },
      coligada: str('CODCOLIGADA (default 0)'),
      aplicacao: str('CODAPLICACAO (default G)'),
      params: { type: 'object', description: 'parâmetros extras da sentença {NOME:valor}' },
    }, ['codSentenca', 'fields']),
    handler: async ({ codSentenca, fields, coligada, aplicacao, params }) => {
      const r = await client.rmQuery(codSentenca, fields, coligada || '0', aplicacao || 'G', params || {});
      return { columns: r.columns, total: r.values.length, values: r.values.slice(0, 200) };
    },
  },
  {
    name: 'fluig_process_start',
    description: 'INICIA uma solicitação (startProcess SOAP). cardData={campo:valor} do formulário. choosedState=estado destino ao concluir o início (ex.: gateway seguinte). Autentica como o usuário (precisa do papel de início). Retorna {processInstanceId(iProcess), rows}.',
    inputSchema: S({
      processId: str('COD_DEF_PROCES (ex: "WRH16 - Solicitação e Avaliação Psicológica")'),
      choosedState: num('estado destino (nº do próximo nó/gateway)'),
      cardData: { type: 'object', description: '{campo:valor} — MANDE TODOS os campos do form (a API substitui o card, não faz merge)' },
      colleagueIds: { type: 'array', items: { type: 'string' }, description: 'próximos responsáveis (opcional)' },
      comments: str('comentário (opcional)'),
      completeTask: { type: 'boolean', description: 'true=conclui e move (default); false=estaciona no início' },
    }, ['processId', 'choosedState']),
    handler: async ({ processId, choosedState, cardData, colleagueIds, comments, completeTask }) =>
      client.startProcess(processId, { choosedState, cardData: cardData || {}, colleagueIds: colleagueIds || [], comments: comments || '', completeTask: completeTask !== false }),
  },
  {
    name: 'fluig_process_move',
    description: 'SALVA e MOVE uma solicitação existente (saveAndSendTask SOAP). ⚠️ cardData SUBSTITUI o card — envie TODOS os campos que devem persistir (INICIO + etapas), senão são apagados. Faça fluig_process_take antes se a tarefa for de POOL.',
    inputSchema: S({
      processInstanceId: num('iProcess (número da solicitação)'),
      choosedState: num('estado destino (nº do próximo nó/gateway)'),
      cardData: { type: 'object', description: '{campo:valor} — TODOS os campos (substitui o card)' },
      colleagueIds: { type: 'array', items: { type: 'string' }, description: 'próximos responsáveis (opcional)' },
      comments: str('comentário (opcional)'),
      managerMode: { type: 'boolean', description: 'mover como gestor do processo (requer ser gestor)' },
    }, ['processInstanceId', 'choosedState']),
    handler: async ({ processInstanceId, choosedState, cardData, colleagueIds, comments, managerMode }) =>
      client.saveAndSendTask(processInstanceId, { choosedState, cardData: cardData || {}, colleagueIds: colleagueIds || [], comments: comments || '', managerMode: !!managerMode }),
  },
  {
    name: 'fluig_process_take',
    description: 'Assume/toma a tarefa (takeProcessTask) — necessário p/ tarefas de POOL/papel antes de mover.',
    inputSchema: S({ processInstanceId: num('iProcess') }, ['processInstanceId']),
    handler: async ({ processInstanceId }) => client.takeProcessTask(processInstanceId),
  },
  {
    name: 'fluig_process_states',
    description: 'Lista os estados válidos de movimentação (choosedState) a partir do estado atual da solicitação (getAvailableStates -> IntArray).',
    inputSchema: S({ processId: str('COD_DEF_PROCES'), processInstanceId: num('iProcess') }, ['processId', 'processInstanceId']),
    handler: async ({ processId, processInstanceId }) => client.getAvailableStates(processId, processInstanceId),
  },
  {
    name: 'fluig_process_card_get',
    description: 'Lê TODO o cardData de uma solicitação em andamento (getInstanceCardData) -> {campo:valor}. Use antes de fluig_process_move p/ reenviar o card completo (o move SUBSTITUI o card).',
    inputSchema: S({ processInstanceId: num('iProcess') }, ['processInstanceId']),
    handler: async ({ processInstanceId }) => client.getInstanceCardData(processInstanceId),
  },
  {
    name: 'fluig_process_card_value',
    description: 'Lê UM campo do card de uma solicitação (getCardValue).',
    inputSchema: S({ processInstanceId: num('iProcess'), cardFieldName: str('nome do campo do form') }, ['processInstanceId', 'cardFieldName']),
    handler: async ({ processInstanceId, cardFieldName }) => client.getCardValue(processInstanceId, cardFieldName),
  },
  {
    name: 'fluig_process_active_states',
    description: 'Lista os estados ATIVOS (nós onde a solicitação está agora) — getAllActiveStates.',
    inputSchema: S({ processInstanceId: num('iProcess') }, ['processInstanceId']),
    handler: async ({ processInstanceId }) => client.getActiveStates(processInstanceId),
  },
  {
    name: 'fluig_process_states_detail',
    description: 'Estados-destino COM detalhe (nome/tipo) a partir do estado atual (getAvailableStatesDetail). Mais rico que fluig_process_states.',
    inputSchema: S({ processId: str('COD_DEF_PROCES'), processInstanceId: num('iProcess'), threadSequence: num('threadSequence (opcional, default 0)') }, ['processId', 'processInstanceId']),
    handler: async ({ processId, processInstanceId, threadSequence }) => client.getAvailableStatesDetail(processId, processInstanceId, threadSequence || 0),
  },
  {
    name: 'fluig_process_actual_thread',
    description: 'Retorna a thread atual de um stateSequence de uma solicitação (getActualThread).',
    inputSchema: S({ processInstanceId: num('iProcess'), stateSequence: num('sequência do estado') }, ['processInstanceId', 'stateSequence']),
    handler: async ({ processInstanceId, stateSequence }) => client.getActualThread(processInstanceId, stateSequence),
  },
  {
    name: 'fluig_process_history',
    description: 'Histórico completo de movimentações da solicitação (getHistories -> quem moveu, quando, de/para qual atividade, comentários).',
    inputSchema: S({ processInstanceId: num('iProcess') }, ['processInstanceId']),
    handler: async ({ processInstanceId }) => client.getProcessHistories(processInstanceId),
  },
  {
    name: 'fluig_process_attachments',
    description: 'Lista os anexos de uma solicitação (getAttachments).',
    inputSchema: S({ processInstanceId: num('iProcess') }, ['processInstanceId']),
    handler: async ({ processInstanceId }) => client.getProcessAttachments(processInstanceId),
  },
  {
    name: 'fluig_process_available',
    description: 'Lista os processos que o usuário logado pode INICIAR (getAvailableProcess).',
    inputSchema: S(),
    handler: async () => client.getAvailableProcesses(),
  },
  {
    name: 'fluig_process_version',
    description: 'Versão ATIVA de um processo via SOAP (getWorkFlowProcessVersion). Funciona SEM o FluiggersWidget.',
    inputSchema: S({ processId: str('COD_DEF_PROCES') }, ['processId']),
    handler: async ({ processId }) => client.getWorkflowVersionSoap(processId),
  },
  {
    name: 'fluig_process_formid',
    description: 'Retorna o documentId do formulário associado a um processo (getProcessFormId).',
    inputSchema: S({ processId: str('COD_DEF_PROCES') }, ['processId']),
    handler: async ({ processId }) => client.getProcessFormId(processId),
  },
  {
    name: 'fluig_process_image',
    description: 'Retorna a imagem do fluxo do processo (getProcessImage) — string (URL/base64 conforme servidor).',
    inputSchema: S({ processId: str('COD_DEF_PROCES') }, ['processId']),
    handler: async ({ processId }) => client.getProcessImage(processId),
  },
  {
    name: 'fluig_process_available_users',
    description: 'Usuários aptos a receber a tarefa num estado da solicitação (getAvailableUsers).',
    inputSchema: S({ processInstanceId: num('iProcess'), state: num('nº do estado'), threadSequence: num('threadSequence (opcional, default 0)') }, ['processInstanceId', 'state']),
    handler: async ({ processInstanceId, state, threadSequence }) => client.getAvailableUsers(processInstanceId, state, threadSequence || 0),
  },
  {
    name: 'fluig_process_available_users_start',
    description: 'Usuários aptos a receber a 1ª tarefa ao INICIAR um processo (getAvailableUsersStart).',
    inputSchema: S({ processId: str('COD_DEF_PROCES'), state: num('nº do estado inicial'), threadSequence: num('threadSequence (opcional, default 0)') }, ['processId', 'state']),
    handler: async ({ processId, state, threadSequence }) => client.getAvailableUsersStart(processId, state, threadSequence || 0),
  },
  {
    name: 'fluig_process_search',
    description: 'Busca processos por texto (searchProcess). favorite=true retorna só os favoritos do usuário.',
    inputSchema: S({ content: str('texto de busca'), favorite: { type: 'boolean', description: 'só favoritos (opcional)' } }, ['content']),
    handler: async ({ content, favorite }) => client.searchProcess(content, !!favorite),
  },
  {
    name: 'fluig_process_cancel',
    description: '⚠️ CANCELA/encerra uma solicitação (cancelInstance SOAP). Escrita — exige confirm=true. Assinatura validada ao vivo (o servidor de homologação 1.8.2).',
    inputSchema: S({ processInstanceId: num('iProcess'), cancelText: str('motivo do cancelamento'), confirm: { type: 'boolean' } }, ['processInstanceId', 'cancelText', 'confirm']),
    handler: async ({ processInstanceId, cancelText, confirm }) => client.cancelProcessInstance(processInstanceId, cancelText || '', { confirm: !!confirm }),
  },
  {
    name: 'fluig_rm_db_exec',
    description: '⚠️ Executa INSERT/UPDATE/DELETE no RM/Corpore (/jdbc/Corpore). Exige confirm=true. OBS: a conexão /jdbc/Corpore costuma ser READ-ONLY p/ tabelas do RM — escrita de laudo etc. vai pelo DataServer (RhuPessoaData), não por aqui.',
    inputSchema: S({ sql: str('INSERT/UPDATE/DELETE'), confirm: { type: 'boolean' } }, ['sql', 'confirm']),
    handler: async ({ sql, confirm }) => {
      const r = await client.rmDbExec(sql, { confirm: !!confirm });
      return { columns: r.columns, values: r.values };
    },
  },
  {
    name: 'fluig_process_export_xml',
    description: 'Baixa o XML da definição de um processo (.ecm30.xml) pela REST v2. Contém TUDO: atividades (ProcessState), transições (ProcessLink), campos e o CÓDIGO dos eventos de processo (WorkflowProcessEvent/eventDescription). Base para editar processo por código.',
    inputSchema: S({
      processId: str('id do processo (ex: Suporte_TI)'),
      version: num('versão específica (opcional; padrão = versão corrente)'),
    }, ['processId']),
    handler: async ({ processId, version }) => client.exportProcessXml(processId, version),
  },
  {
    name: 'fluig_process_events_xml',
    description: 'Lê os eventos de PROCESSO (beforeStateEntry, afterTaskCreate, afterProcessFinish...) com o código-fonte, direto do XML da definição. NÃO precisa do FluiggersWidget nem de ler a tabela event_proces — é a fonte de verdade oficial.',
    inputSchema: S({
      processId: str('id do processo'),
      version: num('versão específica (opcional)'),
    }, ['processId']),
    handler: async ({ processId, version }) => {
      const evs = await client.getProcessEventsFromXml(processId, version);
      return { processId, total: evs.length, eventos: evs };
    },
  },
  {
    name: 'fluig_process_event_set_xml',
    description: '⚠️ ESCRITA. Grava um evento de PROCESSO pelo caminho SUPORTADO: exporta o XML da definição, troca (ou cria) o eventDescription e reimporta — gerando NOVA VERSÃO revertível. Substitui com segurança o fluig_process_event_set (UPDATE direto em event_proces). Use dryRun=true primeiro. Exige confirm=true.',
    inputSchema: S({
      processId: str('id do processo'),
      eventId: str('nome do evento (ex: beforeStateEntry, afterTaskCreate, afterProcessFinish)'),
      code: str('código-fonte COMPLETO do evento (function nome(...){...})'),
      version: num('versão de origem a exportar (opcional)'),
      release: { type: 'boolean', description: 'publicar/liberar a nova versão na mesma chamada (padrão false)' },
      dryRun: { type: 'boolean', description: 'não envia nada; só valida o patch e devolve o tamanho resultante' },
      confirm: { type: 'boolean', description: 'obrigatório true para gravar de fato' },
    }, ['processId', 'eventId', 'code']),
    handler: async ({ processId, eventId, code, version, release, dryRun, confirm }) =>
      client.setProcessEventViaXml(processId, eventId, code, { confirm: !!confirm, version, release: !!release, dryRun: !!dryRun }),
  },
  {
    name: 'fluig_process_import_xml',
    description: '⚠️ ESCRITA ESTRUTURAL. Faz DEPLOY da definição de processo (.ecm30.xml) pela REST v2. UMA chamada substitui a sequência SOAP createWorkFlowProcessVersion→importProcess→releaseProcess (o servidor faz os 3 internamente). release=true publica junto. Exige confirm=true. Valide antes com round-trip (export → import idêntico).',
    inputSchema: S({
      processId: str('id do processo'),
      xml: str('conteúdo do .ecm30.xml (raiz <list><ProcessDefinition>…)'),
      release: { type: 'boolean', description: 'liberar/publicar a versão na mesma chamada' },
      formId: num('documentId do formulário a vincular (opcional)'),
      confirm: { type: 'boolean', description: 'obrigatório true' },
    }, ['processId', 'xml']),
    handler: async ({ processId, xml, release, formId, confirm }) =>
      client.importProcessXml(processId, xml, { confirm: !!confirm, release: !!release, formId }),
  },
  {
    name: 'fluig_process_versions',
    description: 'Lista as versões de um processo (número, formId, se está em edição). Use antes de retirar/apagar versão ou para saber qual versão exportar.',
    inputSchema: S({ processId: str('id do processo') }, ['processId']),
    handler: async ({ processId }) => {
      const v = await client.listProcessVersions(processId);
      return { processId, total: Array.isArray(v) ? v.length : undefined, versions: v };
    },
  },
  {
    name: 'fluig_process_version_withdraw',
    description: '⚠️ ESCRITA. RETIRA do ar (withdraw) uma versão do processo — inverso do release. É o jeito de REVERTER um deploy ruim, e é obrigatório antes de apagar uma versão liberada. Exige confirm=true.',
    inputSchema: S({
      processId: str('id do processo'),
      version: num('versão (opcional; omitido = latest)'),
      confirm: { type: 'boolean', description: 'obrigatório true' },
    }, ['processId']),
    handler: async ({ processId, version, confirm }) => client.withdrawProcessVersion(processId, version, { confirm: !!confirm }),
  },
  {
    name: 'fluig_process_version_delete',
    description: '⚠️ DESTRUTIVO. Apaga uma versão do processo (faça withdraw antes se estiver liberada). ATENÇÃO: apagar a ÚLTIMA versão remove a DEFINIÇÃO DO PROCESSO inteira. Exige confirm=true.',
    inputSchema: S({
      processId: str('id do processo'),
      version: num('versão (opcional; omitido = latest)'),
      confirm: { type: 'boolean', description: 'obrigatório true' },
    }, ['processId']),
    handler: async ({ processId, version, confirm }) => client.deleteProcessVersion(processId, version, { confirm: !!confirm }),
  },
  {
    name: 'fluig_process_diagram_set',
    description: '⚠️ ESCRITA. Atualiza o SVG do diagrama de uma versão do processo (PUT .../diagram). Necessário depois de mudar a topologia no XML, senão o desenho publicado fica desatualizado. Exige confirm=true.',
    inputSchema: S({
      processId: str('id do processo'),
      processVersion: num('versão do processo'),
      svg: str('conteúdo SVG do diagrama'),
      confirm: { type: 'boolean', description: 'obrigatório true' },
    }, ['processId', 'processVersion', 'svg']),
    handler: async ({ processId, processVersion, svg, confirm }) =>
      client.setProcessDiagram(processId, processVersion, svg, { confirm: !!confirm }),
  },
  {
    name: 'fluig_dataset_structure',
    description: 'Retorna a ESTRUTURA de um dataset (colunas + tipos) SEM executá-lo — útil para descobrir o schema antes de montar um fluig_dataset_run. Rota descoberta por eng. reversa do app oficial e confirmada ao vivo.',
    inputSchema: S({ datasetId: str('id do dataset (ex: colleague, ds_generic_rm_sql)') }, ['datasetId']),
    handler: async ({ datasetId }) => client.getDatasetStructure(datasetId),
  },
  {
    name: 'fluig_user_replacements',
    description: 'Lista as SUBSTITUIÇÕES de usuário configuradas (quem responde por quem, com período). Explica por que uma tarefa foi parar em outra pessoa.',
    inputSchema: S({ limit: num('máximo de registros (opcional)') }),
    handler: async ({ limit }) => {
      const rows = await client.getUserReplacements({ limit });
      return { total: Array.isArray(rows) ? rows.length : undefined, replacements: rows };
    },
  },
  {
    name: 'fluig_dataset_delete',
    description: '⚠️ ESCRITA/DESTRUTIVO. Apaga um dataset CUSTOM do servidor (ECMDatasetService.deleteDataset). Serve para o MCP limpar os datasets descartáveis que ele mesmo cria (ds_claude_*). Exige confirm=true.',
    inputSchema: S({
      datasetId: str('id do dataset a apagar'),
      confirm: { type: 'boolean', description: 'obrigatório true' },
    }, ['datasetId']),
    handler: async ({ datasetId, confirm }) => {
      const r = await client.deleteDataset(datasetId, { confirm: !!confirm });
      return { datasetId, deleted: true, result: r };
    },
  },
  {
    name: 'fluig_rest_get',
    description: 'Escape hatch: GET autenticado num caminho arbitrário da API do Fluig.',
    inputSchema: S({ path: str('ex: /ecm/api/rest/ecm/dataset/loadDataset?datasetId=x') }, ['path']),
    handler: async ({ path }) => client.restGet(path),
  },
  {
    name: 'fluig_rest_post',
    description: 'Escape hatch: POST autenticado. body como string JSON; form=true para x-www-form-urlencoded.',
    inputSchema: S({ path: str('caminho'), body: str('corpo (JSON string)'), form: { type: 'boolean' } }, ['path']),
    handler: async ({ path, body, form }) => client.restPost(path, body, !!form),
  },

  // ─── API interna do Painel de Controle (mapeada em 15/09/2026) ────────────────
  // Rotas que as telas /portal/p/1/wcmdatasetpage e /pagejobscheduler usam.
  // Não documentadas pela TOTVS; podem mudar entre versões do Fluig.
  {
    name: 'fluig_dataset_admin',
    description: 'Metadados ADMIN de dataset (o que a tela Datasets mostra): serverOffline, '
      + 'updateInterval, jobLastExecution/jobNextExecution, syncStatus, active/draft. '
      + 'Com code=true traz também o código-fonte. É por AQUI que se descobre se um dataset '
      + 'está agendado — agendamento = serverOffline:true + trigger no Quartz.',
    inputSchema: S({
      search: str('filtro por id/descrição (substring). Vazio = lista tudo.'),
      code: { type: 'boolean', description: 'true inclui o datasetImpl (código-fonte)' },
      pageSize: { type: 'number', description: 'padrão 30' },
    }, []),
    handler: async ({ search = '', code = false, pageSize = 30 }) => {
      const qs = new URLSearchParams({
        type: 'CUSTOM', order: 'datasetId', page: '1', pageSize: String(pageSize),
      });
      qs.append('type', 'GENERATED');
      qs.append('expand', 'dependency');
      if (code) qs.append('expand', 'datasetImpl');
      if (search) qs.set('search', search);
      return client.restGet(`/dataset/api/v1/datasets?${qs}`);
    },
  },
  {
    name: 'fluig_jobs_list',
    description: 'Lista os jobs agendados pela aplicação (Agendador de Tarefas). '
      + 'Passe datasetId para ver só os DatasetSyncJob daquele dataset. '
      + 'É a leitura equivalente a consultar QRTZ_TRIGGERS, mas pela aplicação.',
    inputSchema: S({
      datasetId: str('opcional: filtra pelos jobs de sincronização deste dataset'),
      rows: { type: 'number', description: 'padrão 30' },
    }, []),
    handler: async ({ datasetId, rows = 30 }) => {
      const qs = new URLSearchParams({ _search: 'false', rows: String(rows), page: '1', sidx: '', sord: 'asc' });
      if (datasetId) qs.set('datasetId', datasetId);
      return client.restGet(`/ecm/api/rest/ecm/jobscheduler/getJobs?${qs}`);
    },
  },
  {
    name: 'fluig_job_add',
    description: '⚠️ ESCRITA. Cria um job agendado. Para sincronizar dataset use jobType=23 '
      + 'e informe datasetId. `expression` é cron Quartz — o padrão da casa para integração '
      + 'diária é "0 00 02 1/1 * ? *" (02:00 todo dia). '
      + '⚠️ PRÉ-REQUISITO: o dataset precisa estar com serverOffline=true '
      + '(tela /portal/p/1/datasetsync?datasetId=X, toggle "Sincronizar com o servidor"); '
      + 'sem isso o job é criado mas não sincroniza nada. '
      + 'Confira o resultado com fluig_jobs_list ou lendo QRTZ_TRIGGERS por fluig_db_query.',
    inputSchema: S({
      description: str('descrição do job (aparece na grid do agendador)'),
      expression: str('cron Quartz, ex: 0 00 02 1/1 * ? *'),
      jobType: { type: 'number', description: '23 = Sincronização de Dataset' },
      datasetId: str('obrigatório quando jobType=23'),
    }, ['description', 'expression', 'jobType']),
    handler: async ({ description, expression, jobType, datasetId }) => {
      if (Number(jobType) === 23 && !datasetId) {
        throw new Error('jobType=23 (Sincronização de Dataset) exige datasetId.');
      }
      const data = { description, expression, jobType: String(jobType) };
      if (datasetId) data.datasetId = String(datasetId);
      return client.restPost('/ecm/api/rest/ecm/jobscheduler/addJob/', JSON.stringify(data));
    },
  },
  {
    name: 'fluig_job_delete',
    description: '⚠️ DESTRUTIVO. Apaga job(s) agendado(s). Pegue jobId e jobTypeInt com '
      + 'fluig_jobs_list. ⚠️ jobType é OBRIGATÓRIO — sem ele o servidor devolve '
      + 'NullPointerException (erro que já custou várias tentativas). '
      + 'Confira depois em QRTZ_TRIGGERS por fluig_db_query: a grid da tela mostra estado velho.',
    inputSchema: S({
      jobId: str('jobId exato, como vem em fluig_jobs_list'),
      jobType: { type: 'number', description: 'o jobTypeInt da listagem (23 = Sincronização de Dataset)' },
    }, ['jobId', 'jobType']),
    handler: async ({ jobId, jobType }) => client._restRaw(
      '/ecm/api/rest/ecm/jobscheduler/deleteJob/',
      { method: 'DELETE', contentType: 'application/json;charset=UTF-8', accept: 'application/json',
        body: JSON.stringify({ toDelete: [{ jobId: String(jobId), jobType: Number(jobType) }] }) },
    ),
  },
  {
    name: 'fluig_job_run',
    description: 'Dispara um job agendado sob demanda, sem esperar o cron. '
      + 'Útil para validar um agendamento novo. Confirme o efeito em '
      + 'QRTZ_TRIGGERS.PREV_FIRE_TIME e SERV_DATASET.LAST_REMOTE_SYNC.',
    inputSchema: S({
      jobId: str('jobId de fluig_jobs_list'),
      jobType: { type: 'number', description: 'jobTypeInt da listagem' },
    }, ['jobId', 'jobType']),
    handler: async ({ jobId, jobType }) => client.restPost(
      '/ecm/api/rest/ecm/jobscheduler/runJob',
      JSON.stringify({ jobId: String(jobId), jobType: Number(jobType) }),
    ),
  },
  {
    name: 'fluig_dataset_enable',
    description: '⚠️ ESCRITA. Ativa (active=true) ou desativa um dataset. O id vai no PATH, '
      + 'sem corpo — a rota é por AÇÃO NOMEADA, não REST por id. '
      + '⚠️ NÃO confundir com agendamento: isto é o flag `active`, não `serverOffline`. '
      + 'Um dataset ativo e sem serverOffline continua sem sincronizar.',
    inputSchema: S({
      datasetId: str('id do dataset'),
      ativo: { type: 'boolean', description: 'true = ativar, false = desativar' },
    }, ['datasetId', 'ativo']),
    handler: async ({ datasetId, ativo }) => client._restRaw(
      `/dataset/api/v1/datasets/${ativo ? 'active' : 'disable'}/${encodeURIComponent(datasetId)}`,
      { method: 'PUT', accept: 'application/json' },
    ),
  },

  // ===================== ONDA P0 =====================
  {
    name: 'fluig_session_reset',
    description: 'Descarta a sessão em memória e faz login novo, sem reiniciar o MCP. Use quando uma '
      + 'chamada devolver a PÁGINA DE LOGIN no lugar do dado, ou FDNUnauthenticatedAccessDeniedException.',
    inputSchema: S(),
    handler: async () => client.sessionReset(),
  },
  {
    name: 'fluig_version',
    description: 'Diagnóstico do MCP: ambiente em uso, host, cookies da sessão e quem está autenticado. '
      + 'Primeira coisa a chamar quando o comportamento não bate com o esperado — responde "qual servidor '
      + 'eu estou realmente falando" sem adivinhação.',
    inputSchema: S(),
    handler: async () => ({ toolsDeclaradas: TOOLS.length, ...(await client.versionInfo()) }),
  },
  {
    name: 'fluig_process_version_release',
    description: '⚠️ ESCRITA. PUBLICA uma versão de processo que já existe em edição, sem reimportar XML. '
      + 'Fecha o ciclo que fluig_process_import_xml e fluig_process_event_set_xml abrem (os dois criam '
      + 'versão SEM publicar). Omita processVersion para publicar a última (rota /latest/release). '
      + 'Troca a versão ativa para todas as NOVAS solicitações; as em voo continuam na versão antiga.',
    inputSchema: S({
      processId: str('id da definição do processo'),
      processVersion: num('versão a publicar (omita = latest)'),
      confirm: { type: 'boolean', description: 'obrigatório: ciente de que troca a versão ativa' },
    }, ['processId', 'confirm']),
    handler: async ({ processId, processVersion, confirm }) =>
      client.releaseProcessVersion(processId, processVersion, { confirm: !!confirm }),
  },
  {
    name: 'fluig_task_list',
    description: 'CAIXA DE TAREFAS: o que está pendente, o que venceu e quem está segurando. '
      + '⚠️ pageSize default do BPM v2 é 1000 (máx 1000) — aqui é 100 para não estourar contexto; '
      + 'aumente conscientemente. Em /v2/tasks o processId vira CSV (é assim que o servidor lê).',
    inputSchema: S({
      processId: { type: 'array', items: { type: 'string' }, description: 'filtrar por processo(s)' },
      pageSize: num('linhas por página (default 100, máx 1000)'),
      page: num('página (1-based)'),
      expand: { type: 'array', items: { type: 'string' }, description: 'campos a expandir' },
      fields: { type: 'array', items: { type: 'string' }, description: 'campos a retornar' },
    }),
    handler: async (a) => client.taskList(a),
  },
  {
    name: 'fluig_task_count',
    description: 'Só a CONTAGEM de tarefas pendentes — responde "quantas estão paradas" sem baixar a lista.',
    inputSchema: S({
      processId: { type: 'array', items: { type: 'string' }, description: 'filtrar por processo(s)' },
    }),
    handler: async (a) => client.taskCount(a),
  },
  {
    name: 'fluig_request_list',
    description: 'Lista SOLICITAÇÕES por processo/status/requisitante/faixa de data. Traz formRecordId '
      + '(= cardId) e formId SEM precisar de expand — é a ponte de processo para formulário. '
      + '⚠️ Aqui processId é array repetido (diferente de fluig_task_list, que usa CSV).',
    inputSchema: S({
      processId: { type: 'array', items: { type: 'string' }, description: 'filtrar por processo(s)' },
      pageSize: num('linhas por página (default 100, máx 1000)'),
      page: num('página (1-based)'),
      expand: { type: 'array', items: { type: 'string' } },
      fields: { type: 'array', items: { type: 'string' } },
    }),
    handler: async (a) => client.requestList(a),
  },
  {
    name: 'fluig_card_list',
    description: 'Lê REGISTROS (cards) de um formulário sem passar por BPM e sem SQL. '
      + '⚠️ pageSize default desta rota é 100 (não 1000 como no BPM). documentId é o id do FORMULÁRIO.',
    inputSchema: S({
      documentId: str('documentId do formulário (fichário)'),
      pageSize: num('linhas por página (default 100)'),
      page: num('página (1-based)'),
      fields: { type: 'array', items: { type: 'string' } },
    }, ['documentId']),
    handler: async ({ documentId, ...resto }) => client.cardList(documentId, resto),
  },
  {
    name: 'fluig_card_children_get',
    description: 'Lê as LINHAS PAI-FILHO (tabelas do formulário) de um card, com rowId e tableId — '
      + 'o que fluig_process_card_get NÃO dá (ele devolve o card achatado, com campo___N misturado). '
      + 'É o caminho para conferir rateio, itens de nota, lista de e-mails. '
      + 'A ordem do servidor não é determinística; esta tool já devolve ordenado por rowId.',
    inputSchema: S({
      documentId: str('documentId do formulário'),
      cardId: str('id do registro (card)'),
    }, ['documentId', 'cardId']),
    handler: async ({ documentId, cardId, ...resto }) => client.cardChildren(documentId, cardId, resto),
  },
  {
    name: 'fluig_dataset_history',
    description: 'HISTÓRICO de versões de um dataset, com o código-fonte — o "git log" embutido do Fluig. '
      + '⚠️ Esta rota ignora fields/expand (não tem @ApiFilter), então cada item traz o fonte inteiro '
      + '(~8 KB). Por isso pageSize=3 e fonte truncado por padrão. '
      + '⚠️ O histórico é IMUTÁVEL pela API: senha que já esteve num dataset continua legível aqui.',
    inputSchema: S({
      datasetId: str('id do dataset'),
      pageSize: num('quantas versões (default 3 — cuidado com contexto)'),
      order: str('ordem (default -version = mais nova primeiro)'),
      truncar: { type: 'boolean', description: 'truncar o fonte (default true)' },
    }, ['datasetId']),
    handler: async ({ datasetId, ...resto }) => client.datasetHistory(datasetId, resto),
  },
  {
    name: 'fluig_dataset_draft_check',
    description: 'Existe RASCUNHO pendente neste dataset? Guarda-corpo para chamar ANTES de '
      + 'fluig_dataset_save: gravar por cima atropela em silêncio o trabalho não publicado de outro dev.',
    inputSchema: S({ datasetId: str('id do dataset') }, ['datasetId']),
    handler: async ({ datasetId }) => client.datasetDraftCheck(datasetId),
  },
  {
    name: 'fluig_dataset_restore',
    description: '⚠️ ESCRITA. ROLLBACK de um dataset para versão anterior. Não é destrutivo: a versão '
      + 'atual permanece no histórico. É o que torna editar dataset uma operação reversível — use junto '
      + 'de fluig_dataset_history (para achar a versão) e fluig_dataset_draft_check.',
    inputSchema: S({
      datasetId: str('id do dataset'),
      version: num('versão a restaurar'),
      confirm: { type: 'boolean', description: 'obrigatório: troca o código do dataset no servidor' },
    }, ['datasetId', 'version', 'confirm']),
    handler: async ({ datasetId, version, confirm }) => client.datasetRestore(datasetId, version, { confirm: !!confirm }),
  },

  // ===================== ONDA P1 =====================
  {
    name: 'fluig_process_def_states',
    description: 'DEFINIÇÃO do fluxo: atividades, tipo BPMN, prazo e mecanismo de atribuição de cada '
      + 'etapa. Diferente de fluig_process_states, que é runtime (estados de UMA solicitação). '
      + '⚠️ Sem expand a configuração vem vazia — esta tool já manda os expands certos. '
      + '⚠️ periodId, initialState, forecastedEffort e a expressão do gateway NÃO existem na REST v2: '
      + 'para esses, use fluig_process_export_xml. Não conclua que "a API não tem".',
    inputSchema: S({
      processId: str('id da definição do processo'),
      processVersion: num('versão do processo'),
      stateSequence: num('filtrar uma atividade específica (opcional)'),
      interactives: { type: 'boolean', description: 'só atividades interativas (default true)' },
    }, ['processId', 'processVersion']),
    handler: async ({ processId, processVersion, ...resto }) => client.processDefStates(processId, processVersion, resto),
  },
  {
    name: 'fluig_request_get',
    description: 'Uma SOLICITAÇÃO pelo processInstanceId, com formRecordId (= cardId) e formId. '
      + 'É o caminho de processo → formulário: pegue o formRecordId aqui e leia os dados com '
      + 'fluig_card_children_get / fluig_card_list.',
    inputSchema: S({ processInstanceId: num('id da solicitação') }, ['processInstanceId']),
    handler: async ({ processInstanceId, ...r }) => client.requestGet(processInstanceId, r),
  },
  {
    name: 'fluig_process_possible_assignees',
    description: 'Quem PODE receber a próxima atividade, com filtro por nome e paginação. '
      + 'Chame isto quando um move for recusado com HTTP 412 (destinatário inválido) — é aqui que '
      + 'se descobre quem serve.',
    inputSchema: S({
      processInstanceId: num('id da solicitação'),
      targetState: num('atividade destino'),
      pattern: str('filtro por nome/login (opcional)'),
      pageSize: num('default 50'),
    }, ['processInstanceId']),
    handler: async ({ processInstanceId, ...r }) => client.possibleAssignees(processInstanceId, r),
  },
  {
    name: 'fluig_process_diagram_get',
    description: 'Baixa o SVG do diagrama publicado. Fecha a assimetria com fluig_process_diagram_set: '
      + 'até agora dava para sobrescrever o desenho sem nunca ter lido o original. '
      + 'Informe destino para salvar em arquivo; sem destino devolve o SVG inline.',
    inputSchema: S({
      processId: str('id do processo'),
      processVersion: num('versão'),
      destino: str('caminho do arquivo .svg a gravar (opcional)'),
    }, ['processId', 'processVersion']),
    handler: async ({ processId, processVersion, destino }) => client.processDiagramGet(processId, processVersion, destino),
  },
  {
    name: 'fluig_process_attachment_download',
    description: 'Baixa o BINÁRIO de um anexo de solicitação para um arquivo local. '
      + '⚠️ Usa a rota singular de propósito: na rota plural do produto os parâmetros user e '
      + 'replacedUser estão ambos anotados @QueryParam("user") — um bug que faz replacedUser não ter efeito.',
    inputSchema: S({
      processInstanceId: num('id da solicitação'),
      attachmentSequence: num('sequência do anexo (ver fluig_process_attachments)'),
      destino: str('caminho do arquivo a gravar'),
    }, ['processInstanceId', 'attachmentSequence', 'destino']),
    handler: async ({ processInstanceId, attachmentSequence, destino }) =>
      client.attachmentDownload(processInstanceId, attachmentSequence, destino),
  },
  {
    name: 'fluig_form_fields',
    description: 'Nomes de campo VÁLIDOS de um formulário (SOAP getFormFields). Pré-requisito de '
      + 'qualquer escrita em card: sem isto, gravar campo é adivinhar nome. '
      + '⚠️ O campo chama-se `field` no SOAP e `fieldId` no REST v2.',
    inputSchema: S({ documentId: num('documentId do formulário') }, ['documentId']),
    handler: async ({ documentId }) => client.formFields(documentId),
  },
  {
    name: 'fluig_card_save',
    description: '⚠️ ESCRITA. Cria/altera/apaga registro de formulário e LINHAS FILHAS, headless. '
      + 'acao: criar | atualizar | apagar | criarLinha | editarLinha | apagarLinha. '
      + 'Use fluig_form_fields antes para acertar os nomes de campo. '
      + '⚠️ apagar/apagarLinha são destrutivos.',
    inputSchema: S({
      documentId: str('documentId do formulário'),
      cardId: str('id do registro (não use em acao=criar)'),
      rowId: str('id da linha filha (só nas ações de linha)'),
      acao: { type: 'string', enum: ['criar', 'atualizar', 'apagar', 'criarLinha', 'editarLinha', 'apagarLinha'] },
      dados: { type: 'object', description: 'payload do card/linha {campo: valor}' },
      confirm: { type: 'boolean', description: 'obrigatório: escreve no formulário' },
    }, ['documentId', 'acao', 'confirm']),
    handler: async ({ confirm, ...a }) => client.cardSave(a, { confirm: !!confirm }),
  },
  {
    name: 'fluig_ged_list',
    description: 'Navega o GED: documentos e subpastas de uma pasta. '
      + '⚠️ `order` é OBRIGATÓRIO no servidor — sem ele a rota devolve 500, não 400. Esta tool já '
      + 'manda um default seguro. pageSize default aqui é 100.',
    inputSchema: S({
      parentId: str('id da pasta (1 = raiz)'),
      order: str('documentDescription | lastModifiedDate | documentId | priority | size | favorite (prefixo - inverte)'),
      pageSize: num('default 100'),
      page: num('página'),
    }, ['parentId']),
    handler: async ({ parentId, ...r }) => client.gedList(parentId, r),
  },
  {
    name: 'fluig_ged_path',
    description: 'Breadcrumb do GED: resolve o caminho de um documento desde a raiz. '
      + 'Use para descobrir onde um documento realmente está antes de publicar algo ao lado dele.',
    inputSchema: S({ documentId: str('id do documento'), rootId: str('raiz (default 1)') }, ['documentId']),
    handler: async ({ documentId, rootId }) => client.gedPath(documentId, rootId || 1),
  },
  {
    name: 'fluig_ged_download',
    description: 'Baixa o conteúdo de um documento do GED para arquivo local, junto dos metadados. '
      + '⚠️ O Content-Type do /stream NÃO é confiável (a implementação reusa o helper dos thumbnails) '
      + '— confie no Content-Disposition e na extensão.',
    inputSchema: S({
      documentId: str('id do documento'),
      destino: str('caminho do arquivo a gravar'),
    }, ['documentId', 'destino']),
    handler: async ({ documentId, destino }) => client.gedDownload(documentId, destino),
  },
  {
    name: 'fluig_process_error_log',
    description: 'FORENSE de solicitação travada: o que o motor tentou executar e com qual payload '
      + '(PROCES_WORKFLOW_ERROR_LOG). É a primeira parada quando uma solicitação "sumiu" ou parou sem explicação. '
      + '⚠️ Passa por fluig_db_query, que grava dataset no servidor — em env="prod" exige confirm=true.',
    inputSchema: S({
      processInstanceId: num('id da solicitação'),
      confirm: { type: 'boolean', description: 'obrigatório em env="prod"' },
    }, ['processInstanceId']),
    handler: async ({ processInstanceId, confirm }) => {
      const r = await client.processErrorLog(processInstanceId, { confirm: !!confirm });
      return { columns: r.columns, total: r.values.length, values: r.values.slice(0, 50) };
    },
  },
  {
    name: 'fluig_form_create',
    description: '⚠️ ESCRITA. Cria um FORMULÁRIO (fichário) novo a partir de um ZIP com o HTML. '
      + 'parentId é a pasta do GED onde ele nasce — descubra com fluig_ged_list.',
    inputSchema: S({
      formName: str('nome do formulário'),
      parentId: str('pasta do GED onde criar'),
      zipPath: str('caminho local do ZIP com o HTML do formulário'),
      confirm: { type: 'boolean', description: 'obrigatório: cria documento no GED' },
    }, ['formName', 'parentId', 'zipPath', 'confirm']),
    handler: async ({ confirm, ...a }) => client.formCreate(a, { confirm: !!confirm }),
  },
  {
    name: 'fluig_process_convert_instances',
    description: '🛑 A OPERAÇÃO MAIS DESTRUTIVA DO MCP. Migra solicitações ABERTAS para uma nova versão '
      + 'do processo. Converter FINALIZA as tarefas pendentes e cria novas no destino — mapeamento '
      + 'errado significa trabalho em curso PERDIDO, sem volta. '
      + 'Chame primeiro SEM confirm para ver o dryRun com o mapeamento, revise par a par, e só então '
      + 'confirme. Descubra as instâncias com fluig_request_list e as atividades com fluig_process_def_states. '
      + 'Nunca rode em lote sem revisar.',
    inputSchema: S({
      processInstanceId: { type: 'array', items: { type: 'number' }, description: 'solicitações a converter' },
      newVersion: num('versão destino'),
      actualStates: { type: 'array', items: { type: 'number' }, description: 'atividades de origem' },
      newStates: { type: 'array', items: { type: 'number' }, description: 'atividades de destino (pares posicionais com actualStates)' },
      confirm: { type: 'boolean', description: 'executa de verdade; sem isso devolve dryRun' },
    }, ['processInstanceId', 'newVersion', 'actualStates', 'newStates']),
    handler: async ({ confirm, ...a }) => client.convertProcessInstances(a, { confirm: !!confirm }),
  },

  // ===================== ONDA P2 =====================
  {
    name: 'fluig_process_activities_resume',
    description: 'HEATMAP do processo: quantas instâncias estão paradas em cada atividade, com os '
      + 'contadores de SLA. Responde "onde o fluxo está entalado" numa chamada. '
      + '⚠️ Só esta rota /resume aceita expand/interactives — as irmãs não. '
      + '⚠️ BUG DO PRODUTO: falha com javax.ejb.EJBException em ALGUNS processos (medido em produção: '
      + 'WAP01 e aberturaDeVaga falham; WRH14_MovimentoFolha e WSUP05 funcionam), independente dos '
      + 'parâmetros. Se cair nisso, use fluig_task_list/fluig_request_list filtrando por processo.',
    inputSchema: S({
      processId: str('id do processo'),
      processVersion: num('versão'),
      interactives: { type: 'boolean', description: 'só atividades interativas (default true)' },
    }, ['processId', 'processVersion']),
    handler: async ({ processId, processVersion, ...r }) => client.activitiesResume(processId, processVersion, r),
  },
  {
    name: 'fluig_deadline_calc',
    description: 'Calcula prazo em HORÁRIO ÚTIL pelo calendário do servidor. modo: duracao | fim | inicio. '
      + '⚠️ A API trabalha em SEGUNDOS, mas o deadlineTime do modelo de processo é gravado em MINUTOS — '
      + 'passar um pelo outro erra o prazo por 60×. Use duracaoEmMinutos que a tool converte. '
      + 'Obrigatórios: duracao = startDate+endDate · fim = startDate+segundos · inicio = endDate+segundos.',
    inputSchema: S({
      modo: { type: 'string', enum: ['duracao', 'fim', 'inicio'] },
      startDate: str('data inicial (ISO, ex: 2026-09-24T08:00:00Z)'),
      endDate: str('data final (ISO)'),
      duration: num('duração em SEGUNDOS (vai como `seconds` na API)'),
      duracaoEmMinutos: num('duração em MINUTOS (convertida p/ segundos pela tool)'),
      localId: num('calendário/local específico (opcional)'),
      periodId: str('período específico (opcional)'),
    }, ['modo']),
    handler: async ({ modo, ...r }) => client.deadlineCalc(modo, r),
  },
  {
    name: 'fluig_workflow_exporter',
    description: 'DOSSIÊ completo de uma solicitação num artefato só (histórico, formulário, anexos). '
      + '⚠️ anonymizeForms é OBRIGATÓRIO aqui: o default do servidor é TRUE e anonimiza os formulários '
      + 'em silêncio — você procuraria o dado achando que sumiu. Informe destino para baixar o ZIP.',
    inputSchema: S({
      processInstanceId: num('id da solicitação'),
      anonymizeForms: { type: 'boolean', description: 'true anonimiza os formulários; escolha explícita' },
      destino: str('caminho do .zip a gravar (opcional; sem isso devolve o dossiê em texto)'),
    }, ['processInstanceId', 'anonymizeForms']),
    handler: async ({ processInstanceId, ...r }) => client.workflowExporter(processInstanceId, r),
  },
  {
    name: 'fluig_ged_upload',
    description: '⚠️ ESCRITA. Sobe um arquivo local para uma pasta do GED e publica. '
      + 'Usa a rota de UMA chamada de propósito: a de duas etapas renomeia o arquivo para [epoch]nome '
      + 'e descarta campos em silêncio.',
    inputSchema: S({
      caminhoLocal: str('arquivo local a subir'),
      parentId: str('pasta do GED de destino'),
      nomeArquivo: str('nome no GED (default: nome do arquivo local)'),
      confirm: { type: 'boolean', description: 'obrigatório: publica documento no GED' },
    }, ['caminhoLocal', 'parentId', 'confirm']),
    handler: async ({ caminhoLocal, parentId, nomeArquivo, confirm }) =>
      client.gedUpload(caminhoLocal, parentId, { nomeArquivo, confirm: !!confirm }),
  },
  {
    name: 'fluig_card_html_url',
    description: 'URL renderizada de uma ficha de formulário. '
      + '⚠️ A URL carrega TOKEN DE ACESSO ao documento — não repassar nem registrar em log. '
      + '⚠️ Esta rota NÃO aceita cardId. Os parâmetros são documentId/documentVersionId (ficha avulsa) '
      + 'ou processId+processInstanceId (ficha de uma solicitação). Combinação inválida devolve HTTP 500, '
      + 'não 400 — todos os parâmetros são "opcionais" na spec, mas o servidor exige um conjunto coerente.',
    inputSchema: S({
      documentId: num('documentId do formulário'),
      documentVersionId: num('versão do documento'),
      processId: str('id do processo (para ficha de solicitação)'),
      processInstanceId: num('id da solicitação'),
      currentMovto: num('movimento atual'),
      editable: { type: 'boolean', description: 'abrir editável' },
      managerMode: { type: 'boolean' },
      mobile: { type: 'boolean' },
    }),
    handler: async (a) => client.cardHtmlUrl(a),
  },
  {
    name: 'fluig_service_list',
    description: 'Serviços de integração cadastrados no Fluig (nome exato, URL, tipo, driver) — '
      + 'útil para descobrir como o ambiente fala com o RM e com terceiros. '
      + '🔒 A projeção é FIXA e não inclui colunas de credencial, de propósito. '
      + '⚠️ Passa por fluig_db_query (grava dataset); em env="prod" exige confirm=true.',
    inputSchema: S({ confirm: { type: 'boolean', description: 'obrigatório em env="prod"' } }),
    handler: async ({ confirm }) => {
      const r = await client.serviceList({ confirm: !!confirm });
      return { columns: r.columns, total: r.values.length, values: r.values };
    },
  },
  {
    name: 'fluig_dataset_state_set',
    description: '⚠️ ESCRITA. Ativa, inativa ou converte para CUSTOM um dataset. '
      + '⚠️ desativar é LÓGICO (IS_ACTIVE=false), não apaga — para apagar use fluig_dataset_delete. '
      + '⚠️ NÃO confundir com agendamento: isto é o flag `active`, não o `serverOffline`. '
      + 'Um dataset ativo e sem serverOffline continua sem sincronizar.',
    inputSchema: S({
      datasetId: str('id do dataset'),
      acao: { type: 'string', enum: ['ativar', 'desativar', 'converter'] },
      confirm: { type: 'boolean', description: 'obrigatório' },
    }, ['datasetId', 'acao', 'confirm']),
    handler: async ({ datasetId, acao, confirm }) => client.datasetStateSet(datasetId, acao, { confirm: !!confirm }),
  },
  {
    name: 'fluig_process_move_rest',
    description: '⚠️ ESCRITA. Movimenta a solicitação pela REST v2 (retorno tipado, trata 412). '
      + 'Alternativa a fluig_process_move (SOAP). ⚠️ targetState/movementSequence são int primitivos: '
      + 'OMITIR envia 0, nunca null — com gateway no fluxo, informe targetState sempre. '
      + '⚠️ A semântica de formFields NÃO está confirmada: trate como SUBSTITUIÇÃO e mande o card '
      + 'completo (leia antes com fluig_process_card_get). O 412 volta como dado, com as opções válidas.',
    inputSchema: S({
      processInstanceId: num('id da solicitação'),
      corpo: { type: 'object', description: 'MoveRequest {movementSequence, assignee, targetState, targetAssignee, subProcessTargetState, comment, asManager, formFields}' },
      confirm: { type: 'boolean', description: 'obrigatório: movimenta a solicitação' },
    }, ['processInstanceId', 'corpo', 'confirm']),
    handler: async ({ processInstanceId, corpo, confirm }) => client.moveRest(processInstanceId, corpo, { confirm: !!confirm }),
  },
  {
    name: 'fluig_process_create',
    description: '⚠️ ESCRITA. Cria o esqueleto de um processo novo. Use para processo DESCARTÁVEL de '
      + 'teste (prefixo ZZ_TESTE_*) em vez de experimentar em processo com solicitações abertas.',
    inputSchema: S({
      processId: str('id do processo'),
      processDescription: str('descrição'),
      categoryId: str('categoria (opcional)'),
      formId: num('formulário associado (opcional)'),
      confirm: { type: 'boolean', description: 'obrigatório' },
    }, ['processId', 'processDescription', 'confirm']),
    handler: async ({ confirm, ...a }) => client.processCreate(a, { confirm: !!confirm }),
  },
  {
    name: 'fluig_rm_dataserver_schema',
    description: 'Contrato (schema) de um DataServer do RM — leia ANTES de tentar gravar no ERP. '
      + 'Roda via ServiceManager → wsDataServer.getSchema, o padrão MIP. '
      + '⚠️ Grava um dataset para executar; em env="prod" exige confirm=true.',
    inputSchema: S({
      dataServerName: str('ex: FinLanBaixaData, RhuPessoaData'),
      contexto: str('ex: CODCOLIGADA=1;CODSISTEMA=G;CODUSUARIO=mestre'),
      confirm: { type: 'boolean', description: 'obrigatório em env="prod"' },
    }, ['dataServerName']),
    handler: async ({ dataServerName, contexto, confirm }) => {
      const r = await client.rmDataServerSchema(dataServerName, contexto, { confirm: !!confirm });
      return { columns: r.columns, values: r.values };
    },
  },
  {
    name: 'fluig_rm_save_record',
    description: '🛑 ESCRITA NO ERP. Grava no RM pela BUSINESS LAYER (DataServer.saveRecord) — a forma '
      + 'CERTA, que respeita fórmula, consistência, numeração e rateio, tudo que um UPDATE direto '
      + 'atropela. Prefira esta a fluig_rm_db_exec. '
      + 'Chame primeiro SEM confirm para ver o dryRun; valide o XML contra fluig_rm_dataserver_schema '
      + 'e só então confirme.',
    inputSchema: S({
      dataServerName: str('ex: RhuPessoaData'),
      xml: str('XML do registro conforme o schema do DataServer'),
      contexto: str('ex: CODCOLIGADA=1;CODSISTEMA=G;CODUSUARIO=mestre'),
      confirm: { type: 'boolean', description: 'executa de verdade; sem isso devolve dryRun' },
    }, ['dataServerName', 'xml']),
    handler: async ({ dataServerName, xml, contexto, confirm }) =>
      client.rmSaveRecord(dataServerName, xml, contexto, { confirm: !!confirm }),
  },
];

// Injeta o parâmetro `env` em TODAS as ferramentas de uma vez (em vez de editar as ~20
// definições uma a uma). teste é sempre o default -- quem não passar env continua batendo
// em o servidor de homologação exatamente como antes; prod exige o caller passar env:"prod" explicitamente.
for (const t of TOOLS) {
  t.inputSchema.properties = t.inputSchema.properties || {};
  t.inputSchema.properties.env = {
    type: 'string', enum: ['teste', 'prod'],
    description: 'OBRIGATÓRIO. Ambiente alvo: "teste" (o servidor de homologação — homologação) ou "prod" '
      + '(fluig.exemplo.com.br — PRODUÇÃO REAL). Não há default: a escolha é sempre explícita, '
      + 'para que ninguém leia homologação achando que é produção nem escreva em produção achando '
      + 'que é teste.',
  };
  t.inputSchema.required = [...new Set([...(t.inputSchema.required || []), 'env'])];
}

/**
 * Ferramentas que MUDAM ESTADO no servidor. Lista curada à mão de propósito: heurística por
 * nome errava nos dois sentidos (marcava `ged_list` como escrita e deixava `job_run` passar
 * como leitura), e um modo read-only que vaza uma tool de escrita é pior do que não existir.
 *
 * ⚠️ Inclui tools cuja CONSULTA é read-only mas cuja MECÂNICA grava: `db_query`, `rm_db_query`,
 *    `service_list`, `process_error_log` e `rm_dataserver_schema` precisam gravar um dataset
 *    para executar SQL arbitrário. Elas escrevem no servidor, então entram aqui.
 */
const TOOLS_ESCRITA = new Set([
  'fluig_dataset_save', 'fluig_dataset_delete', 'fluig_dataset_enable', 'fluig_dataset_state_set',
  'fluig_dataset_restore', 'fluig_form_save', 'fluig_form_create', 'fluig_globalevent_save',
  'fluig_process_start', 'fluig_process_move', 'fluig_process_move_rest', 'fluig_process_take',
  'fluig_process_cancel', 'fluig_process_import_xml', 'fluig_process_event_set',
  'fluig_process_event_set_xml', 'fluig_process_diagram_set', 'fluig_process_version_release',
  'fluig_process_version_withdraw', 'fluig_process_version_delete', 'fluig_process_create',
  'fluig_process_convert_instances', 'fluig_deploy_process', 'fluig_job_add', 'fluig_job_delete',
  'fluig_job_run', 'fluig_card_save', 'fluig_ged_upload', 'fluig_workflow_events_update',
  'fluig_rm_db_exec', 'fluig_rm_save_record', 'fluig_rest_post',
  // read-only na intenção, escrita na mecânica (gravam dataset para rodar SQL):
  'fluig_db_query', 'fluig_rm_db_query', 'fluig_service_list', 'fluig_process_error_log',
  'fluig_rm_dataserver_schema',
]);
for (const t of TOOLS) t.write = TOOLS_ESCRITA.has(t.name);

const READONLY = /^(1|true|yes|on)$/i.test(String(process.env.FLUIG_READONLY || ''));
const TOOLS_ATIVAS = READONLY ? TOOLS.filter(t => !t.write) : TOOLS;

const AJUDA = `fluig-mcp — servidor MCP para o TOTVS Fluig

Uso:
  fluig-mcp             Sobe o servidor MCP no stdio (o que o cliente MCP executa).
  fluig-mcp --list      Lista as ferramentas expostas e sai. NÃO precisa de credencial.
  fluig-mcp --version   Mostra a versão e sai.
  fluig-mcp --help      Mostra esta mensagem.

Ambiente (nenhum tem default — veja .env.example):
  Homologação:  FLUIG_HOST       FLUIG_USER       FLUIG_PASS
  Produção:     FLUIG_HOST_PROD  FLUIG_USER_PROD  FLUIG_PASS_PROD

  FLUIG_READONLY=1  expõe SOMENTE as ferramentas que não alteram o servidor.

Toda chamada exige o parâmetro env ("teste" ou "prod"). Não há default: é o que impede
ler homologação achando que é produção — e escrever em produção achando que é teste.`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(AJUDA);
  process.exit(0);
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(VERSAO);
  process.exit(0);
}

if (process.argv.includes('--list')) {
  // NÃO carrega configuração: listar a superfície não pode exigir credencial, para que dê
  // para auditar o que este servidor faz antes de confiar uma senha a ele.
  console.log(`fluig-mcp ${VERSAO} — ${TOOLS_ATIVAS.length} ferramentas${READONLY ? ' (modo somente leitura)' : ''}:`);
  for (const t of TOOLS_ATIVAS) console.log(`  ${t.write ? '!' : ' '} ${t.name}: ${t.description}`);
  if (!READONLY) console.log('\n(! marca as ferramentas que alteram o estado do servidor.)');
  process.exit(0);
}

const configurados = ambientesConfigurados();
if (!configurados.length) {
  console.error(
    'fluig-mcp: nenhum ambiente configurado. Defina FLUIG_HOST/FLUIG_USER/FLUIG_PASS '
    + '(homologação) e/ou FLUIG_HOST_PROD/FLUIG_USER_PROD/FLUIG_PASS_PROD (produção). '
    + 'Veja .env.example. Rode --list para inspecionar as ferramentas sem credencial.',
  );
  process.exit(1);
}

const server = new Server({ name: 'fluig', version: VERSAO }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS_ATIVAS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS_ATIVAS.find(t => t.name === req.params.name);
  if (!tool) {
    const escondida = READONLY && TOOLS.some(t => t.name === req.params.name);
    return {
      content: [{ type: 'text', text: `Ferramenta desconhecida: ${req.params.name}`
        + (escondida ? ' (ela altera o servidor e está oculta porque FLUIG_READONLY está ligado)' : '') }],
      isError: true,
    };
  }
  const args = req.params.arguments || {};
  // `env` é obrigatório e sem default de propósito. Antes, omitir caía em "teste" em silêncio:
  // quem queria produção lia homologação e reportava o dado errado como se fosse de produção.
  if (args.env !== 'teste' && args.env !== 'prod') {
    return {
      content: [{ type: 'text', text:
        `ERRO: a ferramenta ${req.params.name} exige o parâmetro env="teste" ou env="prod". `
        + 'Não existe default — informe o ambiente explicitamente. '
        + 'teste = o servidor de homologação (homologação) · prod = fluig.exemplo.com.br (PRODUÇÃO REAL).' }],
      isError: true,
    };
  }
  try {
    client = clienteDe(args.env);
  } catch (e) {
    return { content: [{ type: 'text', text: 'ERRO: ' + (e?.message || e) }], isError: true };
  }
  try {
    const out = await tool.handler(args);
    return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: 'ERRO: ' + (e?.message || e) }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `fluig-mcp ${VERSAO} pronto (stdio) — ${TOOLS_ATIVAS.length} ferramentas, `
  + `ambiente(s) configurado(s): ${configurados.join(', ')}${READONLY ? ', somente leitura' : ''}.`,
);
