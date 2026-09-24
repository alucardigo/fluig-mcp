import soap from 'soap';
import dns from 'node:dns/promises';
import net from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Cliente da API do TOTVS Fluig — headless (sem IDE). Replica o protocolo da
 * extensão fluig-vscode-extension (Fluiggers).
 *
 * Resiliência de REDE (o problema real do o servidor de homologação): o hostname resolve por DNS
 * interno com "split-horizon" que OSCILA — às vezes devolve um IP inalcançável
 * (rede interna 172.16.x fora da VPN) ou simplesmente estoura timeout, mesmo com
 * o servidor no ar. Em vez de confiar num único lookup, o cliente resolve o IP
 * ele mesmo: junta candidatos (IP aprendido + DNS + seeds), TESTA conexão TCP em
 * cada um em paralelo e fixa o primeiro alcançável (Host header preservado p/ o
 * vhost). Aprende o bom IP por ~60s e, em erro, re-sonda (self-heal). Cobre fetch
 * (REST) e node-soap. Além disso, todas as chamadas passam por retry com backoff.
 */

async function retry(fn, tries = 4, baseMs = 400) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const transient = /fetch failed|timeout|ECONN|ETIMEDOUT|socket|network|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/i.test(e?.message || e?.cause?.code || '');
      if (!transient && i > 0) break; // erro não-transiente: não insiste
      await new Promise(r => setTimeout(r, baseMs * (i + 1)));
    }
  }
  throw lastErr;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/** Testa conexão TCP a um IP:porta. Resolve true/false, nunca lança. */
function tcpOk(ip, port, timeout = 2500) {
  return new Promise((res) => {
    const s = net.connect({ host: ip, port: Number(port), timeout });
    const done = (ok) => { try { s.destroy(); } catch { /* noop */ } res(ok); };
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

/** Sonda os candidatos em paralelo; devolve o PRIMEIRO que conectar (não espera os mortos). */
function firstReachable(ips, port, timeout = 2500) {
  return new Promise((resolve) => {
    let pending = ips.length;
    if (!pending) return resolve(null);
    for (const ip of ips) {
      tcpOk(ip, port, timeout).then((ok) => {
        if (ok) resolve(ip);                    // primeiro alcançável vence (não bloqueia nos mortos)
        else if (--pending === 0) resolve(null); // só espera o timeout se TODOS falharem
      });
    }
  });
}

/**
 * Escolhe um IP alcançável p/ o hostname: [IP aprendido, DNS resolve4, DNS lookup, seeds],
 * cada um com timeout curto, e TCP-proba antes de eleger. Nunca confia num lookup só.
 */
async function pickIp(hostname, port, seeds = [], preferred) {
  if (net.isIP(hostname)) return hostname; // já é IP literal
  const cands = [];
  if (preferred) cands.push(preferred);
  try { for (const ip of await withTimeout(dns.resolve4(hostname), 1500)) if (!cands.includes(ip)) cands.push(ip); } catch { /* dns flaky */ }
  try { for (const a of await withTimeout(dns.lookup(hostname, { all: true, family: 4 }), 1200)) if (!cands.includes(a.address)) cands.push(a.address); } catch { /* noop */ }
  for (const ip of seeds) if (ip && !cands.includes(ip)) cands.push(ip);
  if (!cands.length) return hostname; // último recurso: deixa o SO tentar resolver
  return (await firstReachable(cands, port)) || cands[0];
}

export class FluigClient {
  constructor(cfg) {
    this.host = cfg.host;
    this.envName = cfg.env || 'teste';
    this.isProd = !!cfg.isProd;
    this.user = cfg.user;
    this.pass = cfg.pass;
    this.companyId = cfg.companyId;
    this.userCode = cfg.userCode || cfg.user;
    this._cookie = null;
    this._soap = {};
    const u = new URL(this.host);
    this._proto = u.protocol;                       // 'http:' | 'https:'
    this._hostname = u.hostname;                     // fluig-homolog.exemplo.com.br
    this._port = u.port || (u.protocol === 'https:' ? '443' : '80');
    this._hostHeader = u.host;                        // hostname:port (p/ o vhost)
    this._seeds = cfg.seedIps || [];                 // IPs semente (sempre TCP-probados antes de usar)
    this._live = null;                               // { ip, base, at } aprendido
  }

  /** Base viva (proto//IP:porta) com IP verificado; cacheada ~60s, re-sonda em erro.
   *  HTTPS (prod) NUNCA conecta pelo IP: o cert (fluig.exemplo.com.br, a CA pública) não cobre o
   *  IP público, então fetch por IP quebra a validação TLS (ERR_TLS_CERT_ALTNAME_INVALID).
   *  O truque de "conectar por IP verificado" existe pro DNS INTERNO instável do o servidor de homologação
   *  (HTTP puro, sem TLS) — domínio público de prod resolve normal, não precisa disso. */
  async _liveBase() {
    if (this._proto === 'https:') return { base: `${this._proto}//${this._hostHeader}` };
    if (this._live && Date.now() - this._live.at < 60_000) return this._live;
    const ip = await pickIp(this._hostname, this._port, this._seeds, this._live?.ip);
    this._live = { ip, base: `${this._proto}//${ip}:${this._port}`, at: Date.now() };
    return this._live;
  }

  _bustIp() { this._live = null; } // força re-sonda no próximo request

  /** fetch resiliente: resolve IP verificado + injeta Host (vhost) + retry; re-sonda em falha. */
  /**
   * Fetch resiliente: TCP-proba um endereço alcançável, mas CHAMA PELO HOSTNAME.
   *
   * Antes a chamada ia direto no IP fixado. Isso causava dois problemas reais:
   *   1. o IPS/FortiGuard da MIP bloqueia acesso por IP ("Web Filter Violation", categoria
   *      "Unrated") — pelo hostname a mesma chamada passa;
   *   2. em HTTPS o certificado não bate com o IP (TLS/SNI), então prod falhava por motivo
   *      que parecia rede.
   * A sonda de IP continua valendo: ela diz SE há caminho vivo (e re-sonda quando cai), mas
   * quem vai na URL é o hostname.
   *
   * Crédito: correção trazida do fork de Antonio (antoniosdn/fluig-mcp), commit 95a32af.
   */
  async _fetch(path, opts = {}) {
    return retry(async () => {
      await this._liveBase();               // só para garantir que existe caminho vivo
      const headers = { ...(opts.headers || {}), Host: this._hostHeader };
      try {
        return await fetch(`${this.host}${path}`, { ...opts, headers });
      } catch (e) {
        this._bustIp(); // o endereço sondado pode ter caído: re-sonda na próxima tentativa
        throw e;
      }
    });
  }

  /**
   * Barra escrita NÃO-DECLARADA em produção. Algumas tools têm consulta read-only mas mecânica de
   * escrita (dbQuery/rmDbQuery precisam gravar um dataset para executar o SQL). Em homologação isso
   * passa direto; em produção exige confirm:true, para ninguém sujar o servidor de produção
   * acreditando que está "só consultando".
   */
  _guardProdWrite(nome, opts = {}, artefato = '') {
    if (!this.isProd || opts.confirm === true) return;
    throw new Error(
      `${nome} em PRODUÇÃO exige confirm:true. A CONSULTA é read-only, mas para executá-la o Fluig `
      + `grava ${artefato ? `o dataset ${artefato}` : 'um dataset'} no servidor e registra o SQL em `
      + 'FDN_DATASETHISTORY, que é imutável pela API. Em homologação passa direto. '
      + 'Para ler o RM sem escrever nada, use rmQuery (sentença WS.###) — ela não grava.'
    );
  }

  async login() {
    if (this._cookie) return this._cookie;
    // Sem senha configurada, NÃO tentar: uma tentativa de login com credencial ausente/errada
    // gasta uma das 3 do lockoutThreshold do AD. Falhar aqui é de graça; falhar na rede custa
    // a conta do usuário (incidente de 22/08/2026).
    if (!this.pass) {
      throw new Error(
        `Sem senha configurada para ${this.host} — não vou tentar o login (cada tentativa ` +
        'queima uma das 3 chances antes do AD bloquear a conta). Para PRODUÇÃO defina ' +
        'FLUIG_PASS_PROD no registro do MCP; para homologação, FLUIG_PASS.'
      );
    }
    // Mesmo bloqueio intermitente do IPS/Fortinet visto em _rest() (ver ali) também acerta o
    // login.do em si — um 403 aqui não significa credencial errada, então re-sonda o IP e
    // tenta de novo antes de reportar falha de autenticação (evita alarme falso).
    // ⚠️ NUNCA repetir tentativa quando o servidor RESPONDEU e apenas rejeitou a credencial.
    // Em 22/08/2026 este laço de 3 tentativas BLOQUEOU a conta AD do do usuário
    // (lockoutThreshold do domínio = 3) porque a senha de PROD estava desatualizada.
    // Só re-tentar quando a resposta indica bloqueio de rede/IPS (403/5xx/sem resposta),
    // que é o cenário original para o qual o retry foi criado.
    let lastStatus;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await this._fetch('/portal/api/servlet/login.do', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `j_username=${encodeURIComponent(this.user)}&j_password=${encodeURIComponent(this.pass)}`,
        redirect: 'manual',
      });
      lastStatus = r.status;
      const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      this._cookie = setCookies.map(c => c.split(';')[0]).join('; ');
      if (/JSESSIONIDSSO|jwt\.token/.test(this._cookie)) return this._cookie;
      this._cookie = null;
      // 200 sem cookie de SSO = o Fluig respondeu e RECUSOU a credencial. Abortar já:
      // insistir aqui queima tentativas do AD e bloqueia a conta do usuário.
      if (r.status === 200) {
        throw new Error(
          'Falha no login: o servidor respondeu 200 mas não emitiu JSESSIONIDSSO — credencial recusada. ' +
          'NÃO vou repetir (evita bloquear a conta no AD). Verifique a senha do ambiente ' +
          `(FLUIG_PASS / FLUIG_PASS_PROD) antes de tentar de novo. host=${this.host} user=${this.user}`
        );
      }
      if (attempt < 2) this._bustIp();
    }
    throw new Error(`Falha no login (HTTP ${lastStatus}). Confira host/usuário/senha.`);
  }

  async ping() {
    const cookie = await this.login();
    const r = await this._fetch('/portal/p/api/servlet/ping', { method: 'POST', headers: { Cookie: cookie } });
    return r.ok && (await r.text()).includes('pong');
  }

  async _rest(path, { method = 'GET', body, form = false } = {}) {
    const cookie = await this.login();
    const headers = { Cookie: cookie, Accept: 'application/json' };
    if (body) headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    // O IP "vivo" cacheado por _liveBase() às vezes cai numa rota que o IPS/Fortinet do
    // cliente bloqueia ("Web Filter Violation" / categoria "Unrated" — visto acessando
    // por IP direto em vez de hostname). Isso se disfarça de "dataset não encontrado" pra
    // quem só olha o JSON parse falhar. Detecta a assinatura do bloqueio e força reprova de
    // IP + retry antes de desistir — um IP diferente normalmente não está bloqueado.
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await this._fetch(path, { method, headers, body });
      const text = await r.text();
      try { return JSON.parse(text); } catch { /* segue pro fallback abaixo */ }
      const blocked = /FortiGuard|Web Filter Violation|Web Page Blocked/i.test(text);
      if (blocked && attempt < 2) { this._bustIp(); continue; }
      return { _status: r.status, _raw: text, _blocked: blocked };
    }
  }

  async _soapClient(wsdlPath) {
    if (this._soap[wsdlPath]) return this._soap[wsdlPath];
    const cookie = await this.login();
    const { base } = await this._liveBase();
    const wsdlUrl = `${base}${wsdlPath}`;
    const client = await retry(() => soap.createClientAsync(wsdlUrl, {
      disableCache: true, handleNilAsNull: true,
      endpoint: wsdlUrl.replace('?wsdl', ''),   // fala direto no IP verificado
      wsdl_headers: { Host: this._hostHeader },  // vhost no fetch do WSDL
    }));
    client.addHttpHeader('Host', this._hostHeader);  // vhost nas chamadas SOAP
    client.addHttpHeader('Cookie', cookie);
    this._soap[wsdlPath] = client;
    return client;
  }

  // ---------- Datasets ----------
  async listDatasets() {
    const client = await this._soapClient('/webdesk/ECMDatasetService?wsdl');
    const [res] = await retry(() => client.findAllFormulariesDatasetsAsync({ companyId: this.companyId, username: this.user, password: this.pass }));
    const items = res?.dataset?.item || [];
    return Array.isArray(items) ? items : [items];
  }

  async getCustomDataset(datasetId) {
    return this._rest(`/ecm/api/rest/ecm/dataset/loadDataset?datasetId=${encodeURIComponent(datasetId)}`);
  }

  async runDataset(name, { fields = [], constraints = [], order = [] } = {}) {
    const client = await this._soapClient('/webdesk/ECMDatasetService?wsdl');
    const [res] = await retry(() => client.getDatasetAsync({
      companyId: this.companyId, username: this.user, password: this.pass,
      name, fields: { item: fields }, constraints: { item: constraints }, order: { item: order },
    }));
    const ds = res?.dataset;
    if (!ds) return { columns: [], values: [] };
    const columns = Array.isArray(ds.columns) ? ds.columns : [ds.columns];
    const raw = ds.values == null ? [] : (Array.isArray(ds.values) ? ds.values : [ds.values]);
    const values = raw.map(item => {
      const vals = Array.isArray(item.value) ? item.value : [item.value];
      const o = {};
      columns.forEach((c, i) => { o[c] = (vals[i] && vals[i].$value !== undefined) ? vals[i].$value : (vals[i] ?? null); });
      return o;
    });
    return { columns, values };
  }

  /**
   * Executa um dataset pela REST v2 (`dataset-handle/search`) — SEM gravar nada no servidor.
   * É o caminho read-only de verdade. Use-o sempre que o dataset JÁ EXISTE no Fluig; só quem
   * precisa injetar SQL novo é obrigado a passar por `saveDataset` (ver dbQuery/rmDbQuery).
   *
   * constraints: [{ field, initial, final?, type='MUST'|'SHOULD'|'MUST_NOT', like?:boolean }]
   *
   * ⚠️ `constraintsField` sem `constraintsInitialValue` devolve HTTP **500** (não 400) — por isso
   *    o valor inicial é validado aqui, antes de sair da máquina.
   * ⚠️ Dataset inexistente devolve **200** com `{"columns":null,"values":null}` — nunca 404.
   *    Sem esta checagem, "dataset não existe" se disfarça de "consulta sem resultado".
   */
  async searchDataset(datasetId, { fields = [], constraints = [], order = [] } = {}) {
    const qs = [`datasetId=${encodeURIComponent(datasetId)}`];
    for (const f of fields) qs.push(`field=${encodeURIComponent(f)}`);
    for (const c of constraints) {
      if (c.initial === undefined || c.initial === null || c.initial === '') {
        throw new Error(`searchDataset: constraint "${c.field}" sem valor inicial — o servidor responderia HTTP 500.`);
      }
      const fin = c.final === undefined ? c.initial : c.final;
      qs.push(`constraintsField=${encodeURIComponent(c.field)}`);
      qs.push(`constraintsInitialValue=${encodeURIComponent(c.initial)}`);
      qs.push(`constraintsFinalValue=${encodeURIComponent(fin)}`);
      qs.push(`constraintsType=${encodeURIComponent(c.type || 'MUST')}`);
      qs.push(`constraintsLikeSearch=${c.like ? 'true' : 'false'}`);
    }
    for (const o of order) qs.push(`orderby=${encodeURIComponent(o)}`);
    const r = await this._rest(`/dataset/api/v2/dataset-handle/search?${qs.join('&')}`);
    if (r && r._raw !== undefined) {
      throw new Error(`searchDataset(${datasetId}): resposta não-JSON (HTTP ${r._status}${r._blocked ? ', bloqueio de rede/FortiGuard' : ''}).`);
    }
    if (!r || (r.columns == null && r.values == null)) {
      throw new Error(
        `searchDataset: o dataset "${datasetId}" devolveu estrutura nula. O Fluig responde 200 com `
        + 'columns/values nulos quando o dataset não existe ou a constraint não bate com o contrato dele — '
        + 'não confunda com "zero linhas".'
      );
    }
    return { columns: r.columns || [], values: r.values || [] };
  }

  _customDatasetStructure(datasetId, code, description) {
    return {
      datasetPK: { companyId: this.companyId, datasetId },
      datasetDescription: description || datasetId,
      datasetImpl: code,
      datasetBuilder: 'com.datasul.technology.webdesk.dataset.CustomizedDatasetBuilder',
      serverOffline: false, mobileCache: false, lastReset: 0, lastRemoteSync: 0,
      type: 'CUSTOM', mobileOffline: false, updateIntervalTimestamp: 0,
    };
  }

  async createDataset(datasetId, code, description) {
    return this._rest('/ecm/api/rest/ecm/dataset/createDataset', {
      method: 'POST', body: JSON.stringify(this._customDatasetStructure(datasetId, code, description)),
    });
  }

  async updateDataset(datasetId, code, description) {
    // getCustomDataset (REST) fica atrás do listDatasets (SOAP) por instantes após um
    // create/update recente — mesma defasagem de cache já vista em getProcessHistories().
    // Retry curto evita falso "não encontrado" sob chamadas dbQuery/rmDbQuery em sequência rápida.
    let existing;
    for (let i = 0; i < 3; i++) {
      existing = await this.getCustomDataset(datasetId);
      if (existing && existing.datasetImpl !== undefined) break;
      if (i < 2) await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
    if (!existing || existing.datasetImpl === undefined) {
      throw new Error(`Dataset custom '${datasetId}' não encontrado para atualizar.`);
    }
    existing.datasetImpl = code;
    if (description) existing.datasetDescription = description;
    return this._rest('/ecm/api/rest/ecm/dataset/editDataset?confirmnewstructure=false', {
      method: 'POST', body: JSON.stringify(existing),
    });
  }

  /** Upsert: cria se não existir, senão atualiza. */
  async saveDataset(datasetId, code, description) {
    const all = await this.listDatasets();
    const exists = all.some(d => d.datasetId === datasetId && d.type === 'CUSTOM');
    return exists ? this.updateDataset(datasetId, code, description) : this.createDataset(datasetId, code, description);
  }

  // ---------- Formulários (ECM CardIndex) ----------
  async listForms() {
    const client = await this._soapClient('/webdesk/ECMCardIndexService?wsdl');
    const [res] = await retry(() => client.getCardIndexesWithoutApproverAsync({ companyId: this.companyId, username: this.user, password: this.pass, colleagueId: this.userCode }));
    const items = res?.result?.item || [];
    return Array.isArray(items) ? items : (items ? [items] : []);
  }

  async getFormEvents(documentId) {
    const client = await this._soapClient('/webdesk/ECMCardIndexService?wsdl');
    const [res] = await retry(() => client.getCustomizationEventsAsync({ companyId: this.companyId, username: this.user, password: this.pass, documentId }));
    const items = res?.result?.item || [];
    return Array.isArray(items) ? items : (items ? [items] : []);
  }

  async getFormFileNames(documentId) {
    const client = await this._soapClient('/webdesk/ECMCardIndexService?wsdl');
    const [res] = await retry(() => client.getAttachmentsListAsync({ companyId: this.companyId, username: this.user, password: this.pass, documentId, colleagueId: this.userCode }));
    const items = res?.result?.item || [];
    return Array.isArray(items) ? items : (items ? [items] : []);
  }

  async getFormFileBase64(documentId, version, fileName) {
    const client = await this._soapClient('/webdesk/ECMCardIndexService?wsdl');
    const [res] = await retry(() => client.getCardIndexContentAsync({ companyId: this.companyId, username: this.user, password: this.pass, documentId, colleagueId: this.userCode, version, nomeArquivo: fileName }));
    return res?.folder || '';
  }

  /** Lê o formulário INTEIRO (metadados + todos os arquivos em texto + eventos). */
  async getFormFull(documentId, version) {
    const meta = (await this.listForms()).find(f => String(f.documentId) === String(documentId)) || {};
    const names = await this.getFormFileNames(documentId);
    const files = [];
    for (const fileName of names) {
      const b64 = await this.getFormFileBase64(documentId, version, fileName);
      files.push({ fileName, content: b64 ? Buffer.from(b64, 'base64').toString('utf8') : '' });
    }
    const events = (await this.getFormEvents(documentId)).map(e => ({ eventId: e.eventId, eventDescription: e.eventDescription }));
    return { meta, files, events };
  }

  /**
   * Publica/atualiza um formulário (SOAP updateSimpleCardIndexWithDatasetAndGeneralInfo).
   * opts: { datasetName, cardDescription, descriptionField, files:[{fileName,content}],
   *         events:[{eventId,eventDescription}], versionOption:'0'|'2', principalHtml }
   * Manda TODOS os arquivos/eventos (a API substitui o conjunto).
   */
  async saveForm(documentId, opts) {
    const client = await this._soapClient('/webdesk/ECMCardIndexService?wsdl');
    const attachments = (opts.files || []).map(f => ({
      fileName: f.fileName,
      // Arquivos BINÁRIOS (png/jpg/etc) devem vir em f.contentBase64 — passar binário por
      // string utf8 CORROMPE o arquivo (aprendido na marra: quase quebrei o ícone de lixeira
      // do WADMO06 ao republicar o form).
      filecontent: f.contentBase64 != null
        ? f.contentBase64
        : Buffer.from(f.content, 'utf8').toString('base64'),
      principal: opts.principalHtml
        ? f.fileName === opts.principalHtml
        : /\.html?$/i.test(f.fileName),
    }));
    const customEvents = (opts.events || []).map(e => ({
      eventDescription: e.eventDescription, eventId: e.eventId, eventVersAnt: false,
    }));
    // Ordem dos campos = ordem exata do WSDL (RPC/literal — o server do Fluig parece
    // deserializar por posição, não por nome; fora de ordem, valor cai no campo errado —
    // ex.: cardDescription não-vazio acabou gravado em documentDescription, 2026-08-20).
    const params = {
      username: this.user, password: this.pass, companyId: this.companyId,
      documentId,
      publisherId: this.userCode,
      cardDescription: opts.cardDescription,
      descriptionField: opts.descriptionField || '',
      datasetName: opts.datasetName,
      Attachments: { item: attachments },
      customEvents: { item: customEvents },
      generalInfo: { versionOption: opts.versionOption || '2' },
    };
    const [res] = await retry(() => client.updateSimpleCardIndexWithDatasetAndGeneralInfoAsync(params));
    const item = res?.result?.item || res?.result || res;
    return item?.webServiceMessage || JSON.stringify(item);
  }

  // ---------- Eventos globais ----------
  async listGlobalEvents() {
    return this._rest('/ecm/api/rest/ecm/globalevent/getEventList');
  }

  async saveGlobalEvent(eventId, code) {
    const list = await this.listGlobalEvents();
    const arr = Array.isArray(list) ? list.slice() : [];
    const dto = { globalEventPK: { companyId: this.companyId, eventId }, eventDescription: code };
    const idx = arr.findIndex(e => e.globalEventPK && e.globalEventPK.eventId === eventId);
    if (idx === -1) arr.push(dto); else arr[idx] = dto;
    const cookie = await this.login();
    const r = await this._fetch('/ecm/api/rest/ecm/globalevent/saveEventList', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: JSON.stringify(arr),
    });
    return r.json();
  }

  // ---------- Workflow (eventos de processo — requer FluiggersWidget) ----------
  async hasFluiggersWidget() {
    const cookie = await this.login();
    const r = await this._fetch('/fluiggersWidget/api/ping', { headers: { Cookie: cookie } });
    return r.status === 200 && (await r.text()).trim() === 'pong';
  }

  async getWorkflowVersion(processId) {
    const cookie = await this.login();
    const r = await this._fetch(`/fluiggersWidget/api/workflows/${encodeURIComponent(processId)}/version`, { headers: { Cookie: cookie } });
    return r.ok ? parseInt(await r.text(), 10) : 0;
  }

  async getWorkflowEvents(processId, version) {
    const cookie = await this.login();
    const r = await this._fetch(`/fluiggersWidget/api/workflows/${encodeURIComponent(processId)}/${version}/events`, { headers: { Cookie: cookie } });
    if (!r.ok) throw new Error(`Falha ao ler eventos do processo (HTTP ${r.status}). FluiggersWidget instalado?`);
    return r.json();
  }

  async updateWorkflowEvents(processId, version, events) {
    const cookie = await this.login();
    const r = await this._fetch(`/fluiggersWidget/api/workflows/${encodeURIComponent(processId)}/${version}/events`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(events),
    });
    if (!r.ok) throw new Error(`Falha ao gravar eventos (HTTP ${r.status}). FluiggersWidget instalado?`);
    return r.json();
  }

  // ---------- Passthrough REST (escape hatch) ----------
  async restGet(path) { return this._rest(path); }
  async restPost(path, body, form = false) {
    return this._rest(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), form });
  }

  // ---------- DB do Fluig (TOTVSECM) via dataset passthrough ----------
  /**
   * ⚠️ O SELECT é read-only, mas a TOOL NÃO É: para executar SQL arbitrário o Fluig exige que ele
   * viva dentro de um dataset, então cada chamada GRAVA `ds_claude_dbquery` no servidor e deixa
   * uma entrada imutável em FDN_DATASETHISTORY — com o SQL dentro. Em produção isso é rastro
   * permanente, por isso exige confirm explícito lá.
   *
   * Um passthrough permanente que recebesse o SQL por constraint eliminaria a escrita, mas criaria
   * coisa pior: um dataset publicado que executa SQL de QUALQUER chamador com permissão de rodar
   * dataset. Trocar rastro de escrita por elevação de privilégio é mau negócio — por isso não foi feito.
   * Para ler o RM sem escrever nada, use rmQuery (sentença WS.###), que roda pelo dataset-handle/search.
   */
  async dbQuery(sql, opts = {}) {
    if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('dbQuery: apenas SELECT/WITH é permitido.');
    this._guardProdWrite('dbQuery', opts, 'ds_claude_dbquery');
    const code =
      'function createDataset(fields, constraints, sortFields){' +
      'var nd=DatasetBuilder.newDataset();var ic=new javax.naming.InitialContext();var ds=ic.lookup("/jdbc/AppDS");' +
      'var sql=' + JSON.stringify(sql) + ';var created=false,conn=null,stmt=null,rs=null;' +
      'try{conn=ds.getConnection();stmt=conn.createStatement();rs=stmt.executeQuery(sql);var cc=rs.getMetaData().getColumnCount();' +
      'while(rs.next()){if(!created){for(var i=1;i<=cc;i++){nd.addColumn(rs.getMetaData().getColumnName(i));}created=true;}' +
      'var a=new Array();for(var i=1;i<=cc;i++){var o=rs.getObject(i);a[i-1]=(o!=null)?o.toString():"null";}nd.addRow(a);}' +
      'if(!created){nd.addColumn("INFO");nd.addRow(new Array("0 linhas"));}}' +
      'catch(e){nd.addColumn("ERRO");nd.addRow(new Array(""+e.message));}' +
      'finally{if(rs!=null)rs.close();if(stmt!=null)stmt.close();if(conn!=null)conn.close();}return nd;}';
    await this.saveDataset('ds_claude_dbquery', code, 'Claude dbQuery (passthrough — read-only)');
    return this.runDataset('ds_claude_dbquery');
  }

  /** SELECT no banco do RM/Corpore (/jdbc/Corpore). ⚠️ Mesma ressalva do dbQuery: a CONSULTA é
   *  read-only, mas a tool grava `ds_claude_rmdbquery` no servidor para conseguir executá-la. */
  async rmDbQuery(sql, opts = {}) {
    if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('rmDbQuery: apenas SELECT/WITH é permitido.');
    this._guardProdWrite('rmDbQuery', opts, 'ds_claude_rmdbquery');
    const code =
      'function createDataset(fields, constraints, sortFields){' +
      'var nd=DatasetBuilder.newDataset();var ic=new javax.naming.InitialContext();var ds=ic.lookup("/jdbc/Corpore");' +
      'var sql=' + JSON.stringify(sql) + ';var created=false,conn=null,stmt=null,rs=null;' +
      'try{conn=ds.getConnection();stmt=conn.createStatement();rs=stmt.executeQuery(sql);var cc=rs.getMetaData().getColumnCount();' +
      'while(rs.next()){if(!created){for(var i=1;i<=cc;i++){nd.addColumn(rs.getMetaData().getColumnName(i));}created=true;}' +
      'var a=new Array();for(var i=1;i<=cc;i++){var o=rs.getObject(i);a[i-1]=(o!=null)?o.toString():"null";}nd.addRow(a);}' +
      'if(!created){nd.addColumn("INFO");nd.addRow(new Array("0 linhas"));}}' +
      'catch(e){nd.addColumn("ERRO");nd.addRow(new Array(""+e.message));}' +
      'finally{if(rs!=null)rs.close();if(stmt!=null)stmt.close();if(conn!=null)conn.close();}return nd;}';
    await this.saveDataset('ds_claude_rmdbquery', code, 'Claude rmDbQuery (Corpore — read-only)');
    return this.runDataset('ds_claude_rmdbquery');
  }

  /** Executa INSERT/UPDATE/DELETE no RM/Corpore (/jdbc/Corpore) via dataset-exec. Exige confirm:true.
      ⚠️ ESCRITA no banco do RM — use só em homolog e com consciência. Retorna linhas afetadas. */
  async rmDbExec(sql, opts = {}) {
    if (opts.confirm !== true) throw new Error('rmDbExec exige { confirm:true } (escrita no Corpore).');
    if (/^\s*(select|with)\b/i.test(sql)) throw new Error('rmDbExec é p/ escrita; use rmDbQuery p/ SELECT.');
    const code =
      'function createDataset(fields, constraints, sortFields){' +
      'var nd=DatasetBuilder.newDataset();nd.addColumn("AFFECTED");' +
      'var ic=new javax.naming.InitialContext();var ds=ic.lookup("/jdbc/Corpore");var conn=null,ps=null;' +
      'try{conn=ds.getConnection();ps=conn.prepareStatement(' + JSON.stringify(sql) + ');var n=ps.executeUpdate();nd.addRow(new Array(""+n));}' +
      'catch(e){nd.addColumn("ERRO");nd.addRow(new Array(""+e.message));}' +
      'finally{if(ps!=null)ps.close();if(conn!=null)conn.close();}return nd;}';
    await this.saveDataset('ds_claude_rmexec', code, 'Claude rmDbExec (Corpore WRITE)');
    return this.runDataset('ds_claude_rmexec');
  }

  // ---------- RM via ds_generic_rm_sql (sentença homologada WS.###) ----------
  /**
   * Consulta o RM pelo padrão MIP: ds_generic_rm_sql + CODSENTENCA/CODCOLIGADA/CODAPLICACAO (+params).
   *
   * Antes esta função GRAVAVA um dataset (`ds_claude_rmquery`) a cada chamada só para poder
   * executá-lo — uma tool anunciada como read-only que escrevia no servidor e deixava rastro
   * imutável em FDN_DATASETHISTORY. Como `ds_generic_rm_sql` já existe no Fluig, dá para chamá-lo
   * direto pelo `dataset-handle/search`, passando os mesmos parâmetros como constraint. Zero escrita.
   */
  async rmQuery(codSentenca, fields, coligada = '0', aplicacao = 'G', params = {}) {
    if (!Array.isArray(fields) || !fields.length) throw new Error('rmQuery: informe os campos (fields) esperados da sentença.');
    const constraints = [
      { field: 'CODSENTENCA', initial: String(codSentenca) },
      { field: 'CODCOLIGADA', initial: String(coligada) },
      { field: 'CODAPLICACAO', initial: String(aplicacao) },
      ...Object.keys(params).map(k => ({ field: k, initial: String(params[k]) })),
    ];
    return this.searchDataset('ds_generic_rm_sql', { fields, constraints });
  }

  // ---------- Eventos de PROCESSO via banco (event_proces) — sem widget ----------
  /** Lê o código (DSL_EVENT) de um evento de processo. */
  async getProcessEventCode(processCode, eventName, version) {
    const r = await this.dbQuery(
      "SELECT CAST(e.DSL_EVENT AS NVARCHAR(MAX)) AS CODE FROM event_proces e WITH(NOLOCK) " +
      "WHERE e.COD_DEF_PROCES LIKE '%" + String(processCode).replace(/'/g, "''") + "%' " +
      "AND e.COD_EVENT='" + String(eventName).replace(/'/g, "''") + "' AND e.NUM_VERS=" + parseInt(version, 10));
    return r.values.length ? r.values[0].CODE : null;
  }

  /**
   * Grava um evento de processo direto na event_proces (mesmo mecanismo do FluiggersWidget,
   * mas nosso e com BACKUP obrigatório). Exige confirm:true. Retorna { backup, affected }.
   * ⚠️ Escreve in-place na versão publicada — use só com consciência (homolog).
   */
  async setProcessEvent(processCode, eventName, version, newCode, opts = {}) {
    if (opts.confirm !== true) throw new Error('setProcessEvent exige { confirm:true } (escrita em event_proces).');
    const backup = await this.getProcessEventCode(processCode, eventName, version);
    // Resolve o COD_DEF_PROCES/COD_EMPRESA EXATOS (o processCode costuma ser um trecho;
    // o valor real é o processId completo). Sem isso o UPDATE exato casa 0 linhas.
    const esc = (s) => String(s).replace(/'/g, "''");
    const meta = await this.dbQuery(
      "SELECT TOP 1 COD_EMPRESA, COD_DEF_PROCES FROM event_proces WITH(NOLOCK) " +
      "WHERE COD_DEF_PROCES LIKE '%" + esc(processCode) + "%' AND COD_EVENT='" + esc(eventName) + "' AND NUM_VERS=" + parseInt(version, 10));
    if (!meta.values.length) throw new Error(`setProcessEvent: evento não encontrado (proc~${processCode}, ${eventName}, v${version}).`);
    const company = parseInt(opts.company || meta.values[0].COD_EMPRESA, 10);
    const codProc = meta.values[0].COD_DEF_PROCES;
    const code =
      'function createDataset(fields, constraints, sortFields){' +
      'var nd=DatasetBuilder.newDataset();nd.addColumn("AFFECTED");' +
      'var ic=new javax.naming.InitialContext();var ds=ic.lookup("/jdbc/AppDS");var conn=null,ps=null;' +
      'try{conn=ds.getConnection();ps=conn.prepareStatement("UPDATE event_proces SET DSL_EVENT=? WHERE COD_EMPRESA=? AND COD_DEF_PROCES=? AND COD_EVENT=? AND NUM_VERS=?");' +
      'ps.setString(1,' + JSON.stringify(newCode) + ');ps.setInt(2,' + company + ');' +
      'ps.setString(3,' + JSON.stringify(String(codProc)) + ');ps.setString(4,' + JSON.stringify(String(eventName)) + ');ps.setInt(5,' + parseInt(version, 10) + ');' +
      'var n=ps.executeUpdate();nd.addRow(new Array(""+n));}' +
      'catch(e){nd.addColumn("ERRO");nd.addRow(new Array(""+e.message));}' +
      'finally{if(ps!=null)ps.close();if(conn!=null)conn.close();}return nd;}';
    await this.saveDataset('ds_claude_dbexec', code, 'Claude setProcessEvent (UPDATE event_proces)');
    const res = await this.runDataset('ds_claude_dbexec');
    return { backup, result: res.values, codProc };
  }

  // ---------- Deploy de PROCESSO (BPMN estrutural) via SOAP — headless, sem Fluig Studio ----------
  /**
   * Token SOAP do TokenService (namespace ws.dm.webdesk…, DIFERENTE do WorkflowEngine).
   * O WorkflowEngineService autentica por ESTE token: ele vai no slot `username` das
   * operações e o `password` vai vazio. Descoberto por eng. reversa do Fluig Studio
   * (WSMethods.reloadToken: token cacheado ~1min; "UT010031" = credencial inválida).
   */
  async getToken() {
    if (this._token && Date.now() - this._tokenAt < 55_000) return this._token;
    const client = await this._soapClient('/webdesk/TokenService?wsdl');
    const [res] = await retry(() => client.getTokenAsync({ login: this.user, password: this.pass }));
    const token = res && (res.result ?? res.return ?? res);
    if (!token || String(token).includes('UT010031')) {
      throw new Error('Fluig getToken falhou (UT010031?): usuário/senha inválidos.');
    }
    this._token = String(token);
    this._tokenAt = Date.now();
    return this._token;
  }

  /** Resolve companyId (tenant) + colleagueId. Se companyId !== -1, usa o configurado. */
  async resolveTenant() {
    if (this.companyId != null && parseInt(this.companyId, 10) !== -1) {
      return { companyId: parseInt(this.companyId, 10), colleagueId: this.userCode || this.user };
    }
    const j = await this._rest(`/portal/api/rest/wcmservice/rest/user/findUserByLogin/?username=${encodeURIComponent(this.user)}&password=${encodeURIComponent(this.pass)}&login=${encodeURIComponent(this.user)}`);
    const c = j.content || j;
    return { companyId: parseInt(c.tenantId, 10), colleagueId: String(c.userCode) };
  }

  /**
   * Publica (DEPLOY) uma definição de processo no Fluig de forma HEADLESS via SOAP
   * WorkflowEngineService — SEM Fluig Studio/Eclipse. Descoberto por eng. reversa
   * (⚠️ nomes invertidos no domínio Fluig: importProcess = SUBIR/deploy; exportProcess = BAIXAR).
   * Sequência: getToken → [update] createWorkFlowProcessVersion → importProcess → releaseProcess.
   *
   * @param {string} processDefXml  conteúdo do .ecm30.xml (raiz <list><ProcessDefinition>…).
   * @param {object} opts { processId?, isNew=false, overWrite=true, svgXml?, confirm }
   * Exige confirm:true (escrita estrutural na definição). O deploy NÃO usa o cookie — usa o token SOAP.
   * ⚠️ 1º uso: validar com round-trip (exportProcess de um processo real → re-deploy idêntico) —
   * o marshaller do Studio remapeia a classe raiz p/ com.datasul.technology.webdesk.workflow (XStream).
   * ⚠️ node-soap é RPC-style aqui; se tropeçar nos nomes de elemento, montar envelope manual (ver MCP.md).
   */
  async deployProcess(processDefXml, opts = {}) {
    if (opts.confirm !== true) throw new Error('deployProcess exige { confirm:true } (deploy estrutural de processo).');
    const processId = opts.processId || (String(processDefXml).match(/<processId>([^<]+)<\/processId>/) || [])[1];
    if (!processId) throw new Error('deployProcess: processId não informado e não encontrado no XML.');
    const isNew = opts.isNew === true;
    const overWrite = opts.overWrite !== false;
    const token = await this.getToken();
    const { companyId, colleagueId } = await this.resolveTenant();
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const item = [{ fileName: `${processId}.ecm30.xml`, principal: true, filecontent: b64(processDefXml) }];
    if (opts.svgXml) item.push({ fileName: `${processId}.processimage.svg`, principal: false, attach: true, filecontent: b64(opts.svgXml) });

    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    if (!isNew) {
      await retry(() => wf.createWorkFlowProcessVersionAsync({ username: token, password: '', companyId, processId }));
    }
    const [imp] = await retry(() => wf.importProcessAsync({
      username: token, password: '', companyId, processId,
      attachments: { item }, newProcess: isNew, overWrite, colleagueId,
    }));
    // releaseProcess: SOAPAction real tem typo "relaseProcess" (o WSDL cuida disso via node-soap)
    const [rel] = await retry(() => wf.releaseProcessAsync({ username: token, password: '', companyId, processId }));
    const released = rel && (rel.result ?? rel.return ?? '');
    if (String(released).includes('ok=false')) throw new Error(`releaseProcess retornou ok=false: ${released}`);
    return { processId, imported: imp && (imp.result ?? imp.return), released };
  }

  /** Lista os processos disponíveis p/ export (útil p/ validar deploy e p/ o round-trip). */
  async listDeployableProcesses() {
    const token = await this.getToken();
    const { companyId } = await this.resolveTenant();
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getAllProcessAvailableToExportAsync({ username: token, password: '', companyId }));
    return res;
  }

  // ---------- Ciclo de vida de SOLICITAÇÃO (start/move) via SOAP WorkflowEngineService ----------
  /** cardData {campo:valor} -> StringArrayArray ({item:[{item:[k,v]},...]}) esperado pelo Fluig. */
  _cardDataToSoap(cardData = {}) {
    return { item: Object.keys(cardData).map(k => ({ item: [String(k), cardData[k] == null ? '' : String(cardData[k])] })) };
  }

  /** Normaliza o retorno StringArrayArray do start/move em [[...],[...]] de strings. */
  _saaToRows(res) {
    const outer = res && (res.item != null ? res.item : (res.result?.item ?? res.return?.item ?? res));
    const rows = Array.isArray(outer) ? outer : (outer ? [outer] : []);
    return rows.map(r => {
      const inner = r && (r.item != null ? r.item : r);
      const arr = Array.isArray(inner) ? inner : [inner];
      return arr.map(v => (v && v.$value !== undefined) ? v.$value : v);
    });
  }

  /**
   * Estados válidos de movimentação (choosedState) a partir do estado atual de uma solicitação.
   * getAvailableStates(username,password,companyId,processId,processInstanceId,threadSequence) -> IntArray.
   */
  async getAvailableStates(processId, processInstanceId, threadSequence = 0) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getAvailableStatesAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      processId, processInstanceId: Number(processInstanceId), threadSequence: Number(threadSequence),
    }));
    const items = res?.item ?? res?.result?.item ?? res;
    const arr = Array.isArray(items) ? items : (items != null ? [items] : []);
    return arr.map(v => (v && v.$value !== undefined) ? Number(v.$value) : Number(v)).filter(n => !isNaN(n));
  }

  /**
   * INICIA uma nova solicitação (startProcess). Autentica como o próprio usuário (que precisa
   * do papel de início). cardData = {campo:valor}. choosedState = estado destino ao concluir a
   * atividade inicial (ex.: 16). completeTask=true conclui e move; false estaciona no início.
   * Retorna { rows, processInstanceId } (o id fica na 1ª célula do retorno).
   */
  async startProcess(processId, { choosedState, cardData = {}, colleagueIds = [], comments = '', completeTask = true, managerMode = false } = {}) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.startProcessAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      processId, choosedState: Number(choosedState),
      colleagueIds: { item: colleagueIds }, comments, userId: this.userCode,
      completeTask: !!completeTask, attachments: { item: [] },
      cardData: this._cardDataToSoap(cardData), appointment: { item: [] },
      managerMode: !!managerMode,
    }));
    const rows = this._saaToRows(res);
    const flat = rows.flat().map(String);
    const pid = flat.find(v => /^\d+$/.test(v));
    return { processInstanceId: pid ? Number(pid) : null, rows };
  }

  /** Assume/toma a tarefa (takeProcessTask) — necessário p/ tarefas de POOL antes de mover. */
  async takeProcessTask(processInstanceId, threadSequence = 0) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.takeProcessTaskAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      userId: this.userCode, processInstanceId: Number(processInstanceId), threadSequence: Number(threadSequence),
    }));
    return res && (res.result ?? res.return ?? res);
  }

  /**
   * SALVA e MOVE uma solicitação existente (saveAndSendTask). Usado p/ avançar entre atividades
   * (16 -> 25 -> Fim). threadSequence normalmente 0.
   */
  async saveAndSendTask(processInstanceId, { choosedState, cardData = {}, colleagueIds = [], comments = '', completeTask = true, managerMode = false, threadSequence = 0 } = {}) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.saveAndSendTaskAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      processInstanceId: Number(processInstanceId), choosedState: Number(choosedState),
      colleagueIds: { item: colleagueIds }, comments, userId: this.userCode,
      completeTask: !!completeTask, attachments: { item: [] },
      cardData: this._cardDataToSoap(cardData), appointment: { item: [] },
      managerMode: !!managerMode, threadSequence: Number(threadSequence),
    }));
    return { rows: this._saaToRows(res) };
  }

  // ---------- Leitura de PROCESSO/SOLICITAÇÃO (WorkflowEngineService) ----------
  /** Extrai o array `.item` do 1º wrapper (part name) presente no retorno RPC. */
  _wfItems(res, ...keys) {
    let node = res;
    for (const k of keys) { if (res && res[k] != null) { node = res[k]; break; } }
    const items = node && (node.item != null ? node.item : node);
    return Array.isArray(items) ? items : (items != null ? [items] : []);
  }

  /** Desembrulha um escalar (o $value do node-soap) do 1º wrapper presente. */
  _wfScalar(res, ...keys) {
    let v = res;
    for (const k of keys) { if (res && res[k] != null) { v = res[k]; break; } }
    return (v && v.$value !== undefined) ? v.$value : v;
  }

  /** Lê TODO o cardData de uma solicitação em andamento (getInstanceCardData) -> {campo:valor}. */
  async getInstanceCardData(processInstanceId) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getInstanceCardDataAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      userId: this.userCode, processInstanceId: Number(processInstanceId),
    }));
    const rows = this._saaToRows(res?.CardData ?? res);
    const card = {};
    for (const r of rows) { const a = Array.isArray(r) ? r : [r]; if (a.length) card[String(a[0])] = a[1] != null ? String(a[1]) : ''; }
    return card;
  }

  /** Lê UM campo do card de uma solicitação (getCardValue). */
  async getCardValue(processInstanceId, cardFieldName) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getCardValueAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      processInstanceId: Number(processInstanceId), userId: this.userCode, cardFieldName,
    }));
    return this._wfScalar(res, 'content', 'result');
  }

  /** Estados ATIVOS (nós onde a solicitação está agora) — getAllActiveStates -> IntArray. */
  async getActiveStates(processInstanceId) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getAllActiveStatesAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      userId: this.userCode, processInstanceId: Number(processInstanceId),
    }));
    return this._wfItems(res, 'States', 'result')
      .map(v => (v && v.$value !== undefined) ? Number(v.$value) : Number(v)).filter(n => !isNaN(n));
  }

  /** Estados-destino COM detalhe (nome/tipo) a partir do atual — getAvailableStatesDetail. */
  async getAvailableStatesDetail(processId, processInstanceId, threadSequence = 0) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getAvailableStatesDetailAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      processId, processInstanceId: Number(processInstanceId), threadSequence: Number(threadSequence),
    }));
    return this._wfItems(res, 'AvailableStatesDetail', 'result');
  }

  /** Thread atual de um stateSequence (getActualThread) -> int. */
  async getActualThread(processInstanceId, stateSequence) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getActualThreadAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      processInstanceId: Number(processInstanceId), stateSequence: Number(stateSequence),
    }));
    return Number(this._wfScalar(res, 'ActualThread', 'result'));
  }

  /** Histórico de movimentações da solicitação (getHistories -> processHistoryDto[]). */
  async getProcessHistories(processInstanceId) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getHistoriesAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      userId: this.userCode, processInstanceId: Number(processInstanceId),
    }));
    return this._wfItems(res, 'Histories', 'result');
  }

  /** Anexos da solicitação (getAttachments -> processAttachmentDto[]). */
  async getProcessAttachments(processInstanceId) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getAttachmentsAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      userId: this.userCode, processInstanceId: Number(processInstanceId),
    }));
    return this._wfItems(res, 'Attachments', 'result');
  }

  /** Processos que o usuário pode INICIAR (getAvailableProcess). */
  async getAvailableProcesses() {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getAvailableProcessAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId), userId: this.userCode,
    }));
    return this._wfItems(res, 'AvailableProcesses', 'result');
  }

  /** Versão ATIVA de um processo via SOAP (getWorkFlowProcessVersion) — funciona SEM o FluiggersWidget. */
  async getWorkflowVersionSoap(processId) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getWorkFlowProcessVersionAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId), processId,
    }));
    return Number(this._wfScalar(res, 'result', 'return'));
  }

  /** documentId do formulário do processo (getProcessFormId) -> int. */
  async getProcessFormId(processId) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getProcessFormIdAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId), processId,
    }));
    return Number(this._wfScalar(res, 'result', 'return'));
  }

  /** Imagem do fluxo do processo (getProcessImage) — string. */
  async getProcessImage(processId) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getProcessImageAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      userId: this.userCode, processId,
    }));
    return this._wfScalar(res, 'Image', 'result');
  }

  /** Usuários aptos a receber a tarefa num estado (getAvailableUsers) -> string[]. */
  async getAvailableUsers(processInstanceId, state, threadSequence = 0) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getAvailableUsersAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      processInstanceId: Number(processInstanceId), state: Number(state), threadSequence: Number(threadSequence),
    }));
    return this._wfItems(res, 'AvailableUsers', 'result').map(v => (v && v.$value !== undefined) ? v.$value : v);
  }

  /** Usuários aptos a receber a 1ª tarefa ao INICIAR (getAvailableUsersStart) -> string[]. */
  async getAvailableUsersStart(processId, state, threadSequence = 0) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.getAvailableUsersStartAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      processId, state: Number(state), threadSequence: Number(threadSequence),
    }));
    return this._wfItems(res, 'AvailableUsers', 'result').map(v => (v && v.$value !== undefined) ? v.$value : v);
  }

  /** Busca processos por texto (searchProcess). favorite=true só favoritos. */
  async searchProcess(content, favorite = false) {
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.searchProcessAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      colleagueId: this.userCode, content, favorite: !!favorite,
    }));
    return this._wfItems(res, 'searchResults', 'result');
  }

  /** ⚠️ CANCELA/encerra uma solicitação (cancelInstance). Exige confirm:true. Assinatura verificada ao vivo. */
  async cancelProcessInstance(processInstanceId, cancelText = '', opts = {}) {
    if (opts.confirm !== true) throw new Error('cancelProcessInstance exige { confirm:true } (cancela/encerra a solicitação).');
    const wf = await this._soapClient('/webdesk/WorkflowEngineService?wsdl');
    const [res] = await retry(() => wf.cancelInstanceAsync({
      username: this.user, password: this.pass, companyId: Number(this.companyId),
      processInstanceId: Number(processInstanceId), userId: this.userCode, cancelText,
    }));
    return this._wfScalar(res, 'result', 'return');
  }

  // ---------- API REST pública (v2) — aceita o MESMO cookie de sessão do login.do ----------
  /**
   * Chamada REST "crua": não força Accept: application/json nem tenta JSON.parse.
   * Necessário para os endpoints que falam XML/SVG (export/import de processo, diagrama).
   * Devolve { status, text, contentType }.
   */
  async _restRaw(path, { method = 'GET', body, contentType, accept } = {}) {
    const cookie = await this.login();
    const headers = { Cookie: cookie };
    if (accept) headers.Accept = accept;
    if (body !== undefined && contentType) headers['Content-Type'] = contentType;
    const r = await this._fetch(path, { method, headers, body });
    const text = await r.text();
    return { status: r.status, text, contentType: r.headers.get('content-type') || '' };
  }

  /**
   * BAIXA o XML da definição de um processo (.ecm30.xml) pela REST v2.
   * @param {string} processId
   * @param {number} [version] versão específica; omitido = versão corrente do processo.
   */
  async exportProcessXml(processId, version) {
    const p = version
      ? `/process-management/api/v2/processes/${encodeURIComponent(processId)}/process-versions/${Number(version)}/export/xml`
      : `/process-management/api/v2/processes/${encodeURIComponent(processId)}/export/xml`;
    const { status, text } = await this._restRaw(p, { accept: 'application/xml' });
    if (status !== 200) throw new Error(`exportProcessXml(${processId}) HTTP ${status}: ${text.slice(0, 300)}`);
    return text;
  }

  /**
   * SOBE (deploy) o XML da definição pela REST v2. O servidor faz internamente
   * createWorkFlowProcessVersion -> importProcess -> [release] (verificado em
   * ProcessServiceInvoker.importProcess decompilado), então UMA chamada substitui
   * as três do SOAP. Usa o usuário da sessão (não precisa de token).
   * Exige confirm:true — é escrita estrutural.
   */
  async importProcessXml(processId, xml, opts = {}) {
    if (opts.confirm !== true) throw new Error('importProcessXml exige { confirm:true } (deploy estrutural de processo).');
    const qs = new URLSearchParams();
    if (opts.release === true) qs.set('release', 'true');
    if (opts.formId != null) qs.set('formId', String(opts.formId));
    // Confirmado em ProcessRest decompilado:
    //   POST /v2/processes/import/xml?processId=X   -> newProcess = TRUE  (cria)
    //   POST /v2/processes/{processId}/import/xml   -> newProcess = FALSE (nova versão do existente)
    if (opts.isNew === true) qs.set('processId', processId);
    const q = qs.toString();
    const p = opts.isNew === true
      ? `/process-management/api/v2/processes/import/xml${q ? '?' + q : ''}`
      : `/process-management/api/v2/processes/${encodeURIComponent(processId)}/import/xml${q ? '?' + q : ''}`;
    const { status, text } = await this._restRaw(p, {
      method: 'POST', body: xml, contentType: 'application/xml', accept: 'application/json',
    });
    if (status < 200 || status >= 300) throw new Error(`importProcessXml(${processId}) HTTP ${status}: ${text.slice(0, 600)}`);
    // releaseProcess do Fluig responde 200 com ok=false no corpo em vez de lançar (ver Studio).
    if (/ok=false/i.test(text)) throw new Error(`importProcessXml(${processId}): servidor retornou ok=false -> ${text.slice(0, 400)}`);
    try { return JSON.parse(text); } catch { return { _status: status, _raw: text }; }
  }

  /**
   * Escapa texto para conteúdo de elemento XML no MESMO estilo que o Fluig serializa:
   * além de &<>, escapa aspas (&quot;/&apos;) e CR (&#xd;). Aspas não seriam obrigatórias
   * em conteúdo de elemento, mas escapá-las torna o round-trip export->import
   * BYTE-IDÊNTICO ao que o servidor gera — que é a propriedade que se quer num deploy.
   */
  _xmlEscape(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      .replace(/\r/g, '&#xd;');
  }

  /** Desescapa o conteúdo de <eventDescription> (entidades XML + numéricas). */
  _xmlUnescape(s) {
    return String(s)
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  /**
   * Lê os eventos de PROCESSO a partir do XML da definição (fonte de verdade oficial),
   * sem FluiggersWidget e sem tocar na tabela event_proces.
   * @returns {Promise<Array<{eventId, version, code}>>}
   */
  async getProcessEventsFromXml(processId, version) {
    const xml = await this.exportProcessXml(processId, version);
    const out = [];
    const re = /<WorkflowProcessEvent>([\s\S]*?)<\/WorkflowProcessEvent>/g;
    let m;
    while ((m = re.exec(xml))) {
      const block = m[1];
      const id = (block.match(/<eventId>([\s\S]*?)<\/eventId>/) || [])[1];
      const ver = (block.match(/<version>([\s\S]*?)<\/version>/) || [])[1];
      const desc = (block.match(/<eventDescription>([\s\S]*?)<\/eventDescription>/) || [])[1];
      if (id) out.push({ eventId: id.trim(), version: ver ? Number(ver) : undefined, code: this._xmlUnescape(desc || '') });
    }
    return out;
  }

  /**
   * ⚠️ GRAVA um evento de PROCESSO pelo caminho SUPORTADO: exporta o XML da definição,
   * troca (ou insere) o <eventDescription> do evento e reimporta. Gera NOVA VERSÃO —
   * revertível — em vez do UPDATE in-place em event_proces.
   * Exige confirm:true. Se release !== true, publica-se depois (a versão fica em edição).
   */
  async setProcessEventViaXml(processId, eventId, code, opts = {}) {
    if (opts.confirm !== true) throw new Error('setProcessEventViaXml exige { confirm:true } (altera a definição do processo).');
    const xml = await this.exportProcessXml(processId, opts.version);
    const esc = this._xmlEscape(code);
    const blockRe = new RegExp(`<WorkflowProcessEvent>(?:(?!</WorkflowProcessEvent>)[\\s\\S])*?<eventId>\\s*${eventId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</eventId>[\\s\\S]*?</WorkflowProcessEvent>`);
    const found = xml.match(blockRe);
    let next, action;
    if (found) {
      // ⚠️ replacement por FUNÇÃO, não por string: código de evento do Fluig é cheio de "$"
      // (jQuery) e String.replace interpretaria $&, $', $` como referências de captura,
      // corrompendo silenciosamente o script na hora do deploy.
      let hit = false;
      const patched = found[0].replace(/<eventDescription>[\s\S]*?<\/eventDescription>/, () => {
        hit = true;
        return `<eventDescription>${esc}</eventDescription>`;
      });
      if (!hit) throw new Error(`setProcessEventViaXml: bloco do evento ${eventId} sem <eventDescription> — abortado.`);
      next = xml.replace(found[0], () => patched);
      action = 'atualizado';
    } else {
      // Evento ainda não existe: cria o bloco reaproveitando companyId/processId/version do XML.
      const companyId = (xml.match(/<companyId>([^<]+)<\/companyId>/) || [])[1];
      const version = (xml.match(/<processDefinitionVersionPK>[\s\S]*?<version>([^<]+)<\/version>/) || [])[1];
      if (!companyId || !version) throw new Error('setProcessEventViaXml: não achei companyId/version no XML para criar o evento.');
      const block = `  <WorkflowProcessEvent>\n    <workflowProcessEventPK>\n      <companyId>${companyId}</companyId>\n      <processId>${processId}</processId>\n      <version>${version}</version>\n      <eventId>${eventId}</eventId>\n    </workflowProcessEventPK>\n    <eventDescription>${esc}</eventDescription>\n  </WorkflowProcessEvent>\n`;
      const lastIdx = xml.lastIndexOf('</WorkflowProcessEvent>');
      if (lastIdx !== -1) {
        const cut = lastIdx + '</WorkflowProcessEvent>'.length;
        next = xml.slice(0, cut) + '\n' + block + xml.slice(cut);
      } else {
        // nenhum evento ainda: insere antes do fechamento da lista
        const close = xml.lastIndexOf('</list>');
        if (close === -1) throw new Error('setProcessEventViaXml: XML sem </list> — formato inesperado.');
        next = xml.slice(0, close) + block + xml.slice(close);
      }
      action = 'criado';
    }
    if (opts.dryRun === true) return { processId, eventId, action, dryRun: true, bytes: next.length };
    const res = await this.importProcessXml(processId, next, { confirm: true, release: opts.release === true, formId: opts.formId });
    return { processId, eventId, action, released: opts.release === true, result: res };
  }

  /** Lista as versões de um processo (número, formId, se está em edição/liberada). */
  async listProcessVersions(processId) {
    const j = await this._rest(`/process-management/api/v2/processes/${encodeURIComponent(processId)}/process-versions`);
    return j?.items ?? j;
  }

  /**
   * ⚠️ RETIRA (withdraw) uma versão do processo — o inverso de release.
   * Necessário antes de apagar: versão LIBERADA não pode ser excluída
   * (o servidor devolve BPMProcessDefinitionVersionReleasedException). Exige confirm:true.
   * @param {string|number} [version] omitido = 'latest'
   */
  async withdrawProcessVersion(processId, version, opts = {}) {
    if (opts.confirm !== true) throw new Error('withdrawProcessVersion exige { confirm:true } (retira a versão do ar).');
    const seg = version == null ? 'latest' : String(Number(version));
    const p = `/process-management/api/v2/processes/${encodeURIComponent(processId)}/process-versions/${seg}/withdraw`;
    const { status, text } = await this._restRaw(p, { method: 'POST', accept: 'application/json' });
    if (status < 200 || status >= 300) throw new Error(`withdrawProcessVersion HTTP ${status}: ${text.slice(0, 300)}`);
    return { processId, version: seg, withdrawn: true };
  }

  /**
   * ⚠️ DESTRUTIVO. Apaga uma versão do processo. Faça withdraw antes se ela estiver liberada.
   * ⚠️ Ao apagar a ÚLTIMA versão, o Fluig remove a DEFINIÇÃO DO PROCESSO inteira
   * (verificado ao vivo: o GET seguinte devolve BPMProcessDefinitionNotFoundException).
   * Exige confirm:true.
   */
  async deleteProcessVersion(processId, version, opts = {}) {
    if (opts.confirm !== true) throw new Error('deleteProcessVersion exige { confirm:true } (apaga versão do processo).');
    const seg = version == null ? 'latest' : String(Number(version));
    const p = `/process-management/api/v2/processes/${encodeURIComponent(processId)}/process-versions/${seg}`;
    const { status, text } = await this._restRaw(p, { method: 'DELETE', accept: 'application/json' });
    if (status < 200 || status >= 300) throw new Error(`deleteProcessVersion HTTP ${status}: ${text.slice(0, 300)}`);
    return { processId, version: seg, deleted: true };
  }

  /** Atualiza o SVG do diagrama de uma versão do processo (PUT .../diagram, application/svg+xml). */
  async setProcessDiagram(processId, processVersion, svg, opts = {}) {
    if (opts.confirm !== true) throw new Error('setProcessDiagram exige { confirm:true }.');
    const p = `/process-management/api/v2/processes/${encodeURIComponent(processId)}/process-versions/${Number(processVersion)}/diagram`;
    const { status, text } = await this._restRaw(p, { method: 'PUT', body: svg, contentType: 'application/svg+xml', accept: 'application/json' });
    if (status < 200 || status >= 300) throw new Error(`setProcessDiagram HTTP ${status}: ${text.slice(0, 400)}`);
    try { return JSON.parse(text); } catch { return { _status: status, _raw: text }; }
  }

  /**
   * Estrutura (colunas + tipos) de um dataset, SEM executá-lo.
   * Endpoint descoberto por engenharia reversa do app oficial `br.com.fluig` 1.17.16
   * (`/api/public/ecm/dataset/datasetStructure/`) e confirmado ao vivo no o servidor de homologação.
   * Resposta: { content: { datasetId, fields: [{ fieldName, dataType }] } }
   */
  async getDatasetStructure(datasetId) {
    const j = await this._rest(`/api/public/ecm/dataset/datasetStructure/${encodeURIComponent(datasetId)}`);
    const c = j?.content ?? j;
    return { datasetId: c?.datasetId ?? datasetId, fields: c?.fields ?? [], _raw: c?.fields ? undefined : j };
  }

  /** Substituições de usuário (quem responde por quem). REST v2 pública. */
  async getUserReplacements({ limit } = {}) {
    const q = limit ? `?limit=${Number(limit)}` : '';
    const j = await this._rest(`/process-management/api/v2/user-replacements${q}`);
    return j?.items ?? j;
  }

  /**
   * ⚠️ APAGA um dataset customizado (ECMDatasetService.deleteDataset).
   * Assinatura confirmada no Fluig Studio (WSMethods.deleteDataset) E no WSDL ao vivo:
   * (companyId:int, username:string, password:string, name:string) — companyId vem PRIMEIRO
   * e o dataset vai em `name` (não `datasetId`). Token no lugar do usuário, senha vazia.
   * Exige confirm:true.
   */
  async deleteDataset(datasetId, opts = {}) {
    if (opts.confirm !== true) throw new Error('deleteDataset exige { confirm:true } (apaga o dataset no servidor).');
    const token = await this.getToken();
    const { companyId } = await this.resolveTenant();
    const ds = await this._soapClient('/webdesk/ECMDatasetService?wsdl');
    const [res] = await retry(() => ds.deleteDatasetAsync({
      companyId, username: token, password: '', name: datasetId,
    }));
    return this._wfScalar(res, 'result', 'return') ?? res;
  }

  // =====================================================================================
  // ONDA P0 — sessão, versão, publicação, runtime e histórico de dataset
  // Paths conferidos contra as specs extraídas do WAR (_analysis/server/specs/*.json),
  // não contra documentação de internet.
  // =====================================================================================

  /**
   * Monta query string com parâmetros REPETIDOS (o padrão do Fluig p/ `field`, `expand`,
   * `constraintsField`, `processId`...). Arrays viram N ocorrências da mesma chave;
   * `undefined`/`null`/'' são omitidos.
   *
   * ⚠️ Booleanos do BPM v2 são STRING com enum ["true","false"] — `?active=1` devolve 400.
   *    Por isso todo boolean é serializado como 'true'/'false'.
   */
  _qs(params = {}) {
    const out = [];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      const push = (x) => out.push(`${encodeURIComponent(k)}=${encodeURIComponent(
        typeof x === 'boolean' ? String(x) : x)}`);
      if (Array.isArray(v)) v.forEach(x => (x !== undefined && x !== null && x !== '') && push(x));
      else push(v);
    }
    return out.length ? `?${out.join('&')}` : '';
  }

  /** Erro amigável para respostas não-JSON (sessão morta, FortiGuard, Accept errado). */
  _assertJson(r, onde) {
    if (r && r._raw !== undefined) {
      const dica = r._blocked ? 'bloqueio de rede/FortiGuard — tente de novo, o client re-sonda o IP'
        : /<title>\s*Login/i.test(r._raw) ? 'a resposta é a PÁGINA DE LOGIN: sessão morta (use fluig_session_reset)'
        : /NotAcceptableException/i.test(r._raw) ? 'Accept errado para esta rota'
        : `HTTP ${r._status}`;
      throw new Error(`${onde}: resposta não-JSON — ${dica}.`);
    }
    if (r && r.code && /Exception/i.test(r.code)) {
      throw new Error(`${onde}: ${r.code}${r.message ? ' — ' + r.message : ''}`);
    }
    return r;
  }

  /** P0#1 — Descarta a sessão em memória e força novo login na próxima chamada. */
  async sessionReset() {
    const antes = this._cookie ? this._cookie.split('; ').map(c => c.split('=')[0]) : [];
    this._cookie = null;
    this._soap = {};
    this._bustIp?.();
    const novo = await this.login();
    return {
      ambiente: this.envName, host: this.host,
      cookiesAntes: antes,
      cookiesAgora: novo.split('; ').map(c => c.split('=')[0]),
    };
  }

  /** P0#2 — Diagnóstico: quem eu sou, onde estou, com que cookies. Mata a dúvida "qual MCP roda". */
  async versionInfo() {
    const cookie = this._cookie || (await this.login());
    const nomes = cookie.split('; ').map(c => c.split('=')[0]);
    let usuario = null;
    try {
      const ui = await this._rest('/authentication/api/v1/login/user-info');
      if (ui && !ui._raw) usuario = { id: ui.id, code: ui.code, admin: ui.admin, tenant: ui.tenantDescription };
    } catch { /* diagnóstico não pode derrubar o diagnóstico */ }
    return {
      ambiente: this.envName, isProd: this.isProd, host: this.host,
      cookies: nomes, temJwtToken: nomes.includes('jwt.token'), usuario,
    };
  }

  /**
   * P0#3 — Publica (release) uma versão de processo que já existe em edição.
   * Fecha o ciclo que import_xml/event_set_xml abrem: os dois criam versão SEM publicar.
   * `processVersion` omitido usa a rota `/process-versions/latest/release`.
   * ⚠️ Devolve 204 sem corpo. Nunca fazer JSON.parse cego.
   */
  async releaseProcessVersion(processId, processVersion, opts = {}) {
    if (opts.confirm !== true) throw new Error('releaseProcessVersion exige { confirm:true } — troca a versão ativa para todas as NOVAS solicitações.');
    const v = (processVersion === undefined || processVersion === null || processVersion === '') ? 'latest' : processVersion;
    const path = `/process-management/api/v2/processes/${encodeURIComponent(processId)}/process-versions/${encodeURIComponent(v)}/release`;
    const r = await this._restRaw(path, { method: 'POST', accept: 'application/json' });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`releaseProcessVersion(${processId} v${v}): HTTP ${r.status} — ${String(r.text).slice(0, 300)}`);
    }
    return { ok: true, processId, processVersion: v, status: r.status, resposta: r.text || '(sem corpo — normal, publica com 204)' };
  }

  /**
   * P0#4 — Caixa de tarefas. ⚠️ `pageSize` default do BPM v2 é 1000 (max 1000) — sempre explícito.
   * ⚠️ Em /v2/tasks o `processId` é String e o invoker faz split(",") — aqui CSV é a ÚNICA forma
   *    que funciona (em /v2/requests é array repetido). Confirmado no bytecode.
   */
  async taskList({ processId, pageSize = 100, page, expand, fields, ...resto } = {}) {
    const qs = this._qs({
      processId: Array.isArray(processId) ? processId.join(',') : processId,
      pageSize, page, expand, fields, ...resto,
    });
    return this._assertJson(await this._rest(`/process-management/api/v2/tasks${qs}`), 'taskList');
  }

  /**
   * P0#4b — Contagem de tarefas.
   * ⚠️ MEDIDO EM 24/09/2026: sem filtro esta rota passa de 120 s no o servidor de homologação (varre a base inteira).
   * Por isso `processId` é obrigatório aqui — contagem global não é utilizável na prática.
   */
  async taskCount(params = {}) {
    const pid = Array.isArray(params.processId) ? params.processId.join(',') : params.processId;
    if (!pid) {
      throw new Error(
        'taskCount exige processId. Sem filtro esta rota varre a base inteira e passa de 120 s '
        + '(medido no o servidor de homologação). Para um panorama geral use fluig_task_list com pageSize pequeno.'
      );
    }
    const qs = this._qs({ ...params, processId: pid });
    return this._assertJson(await this._rest(`/process-management/api/v2/tasks/count${qs}`), 'taskCount');
  }

  // =====================================================================================
  // ONDA P1 — diagnóstico do dia a dia: definição do fluxo, formulário, GED, anexos
  // =====================================================================================

  /** Baixa conteúdo BINÁRIO autenticado (anexo, stream do GED, diagrama). */
  async _restBinary(path, { accept } = {}) {
    const cookie = await this.login();
    const headers = { Cookie: cookie };
    if (accept) headers.Accept = accept;
    const r = await this._fetch(path, { method: 'GET', headers });
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      status: r.status, buffer: buf,
      contentType: r.headers.get('content-type') || '',
      contentDisposition: r.headers.get('content-disposition') || '',
    };
  }

  /** Salva um binário baixado e devolve um resumo (nunca o conteúdo — estouraria o contexto). */
  _salvar(destino, bin, contexto) {
    if (bin.status < 200 || bin.status >= 300) {
      throw new Error(`${contexto}: HTTP ${bin.status} — ${bin.buffer.toString('utf8').slice(0, 300)}`);
    }
    writeFileSync(destino, bin.buffer);
    return {
      arquivo: destino, bytes: bin.buffer.length,
      contentType: bin.contentType, contentDisposition: bin.contentDisposition,
    };
  }

  /**
   * P1#11 — DEFINIÇÃO do fluxo: atividades, tipo BPMN, prazo e mecanismo de atribuição.
   * ⚠️ Sem os `expand`, `configuration` vem VAZIA — por isso eles são o default aqui.
   * ⚠️ A rota SINGULAR (.../states/{seq}) não declara expand: para configuração, use a LISTA.
   * ⚠️ A REST v2 não expõe periodId, initialState nem forecastedEffort, e a condição de gateway vem
   *    sem a expressão. Para esses quatro, só o export XML — não conclua que "a API não tem".
   */
  async processDefStates(processId, processVersion, { interactives = true, stateSequence, expand } = {}) {
    const qs = this._qs({
      interactives,
      stateSequence,
      expand: expand || ['configuration', 'configuration.assignmentConfiguration'],
    });
    const p = `/process-management/api/v2/processes/${encodeURIComponent(processId)}`
      + `/process-versions/${encodeURIComponent(processVersion)}/states${qs}`;
    return this._assertJson(await this._rest(p), 'processDefStates');
  }

  /** P1#12 — Uma solicitação, com formRecordId (= cardId) e formId: a ponte BPM→formulário. */
  async requestGet(processInstanceId, params = {}) {
    const qs = this._qs(params);
    return this._assertJson(
      await this._rest(`/process-management/api/v2/requests/${encodeURIComponent(processInstanceId)}${qs}`),
      'requestGet');
  }

  /**
   * P1#13 — Quem PODE receber a próxima atividade, paginado e com filtro por nome.
   * Par obrigatório do HTTP 412 do move: quando o move recusa por destinatário inválido, é aqui
   * que se descobre quem serve.
   */
  async possibleAssignees(processInstanceId, { targetState, pattern, pageSize = 50, page } = {}) {
    const qs = this._qs({ targetState, pattern, pageSize, page });
    return this._assertJson(
      await this._rest(`/process-management/api/v2/requests/${encodeURIComponent(processInstanceId)}/possible-assignees${qs}`),
      'possibleAssignees');
  }

  /**
   * P1#14 — Baixa o SVG do diagrama publicado. Fecha a assimetria com o diagram_set, que já existia:
   * até agora dava para SOBRESCREVER o desenho sem nunca ter lido o original.
   */
  async processDiagramGet(processId, processVersion, destino) {
    const p = `/process-management/api/v2/processes/${encodeURIComponent(processId)}`
      + `/process-versions/${encodeURIComponent(processVersion)}/diagram`;
    const bin = await this._restBinary(p, { accept: 'application/svg+xml' });
    if (destino) return this._salvar(destino, bin, 'processDiagramGet');
    if (bin.status < 200 || bin.status >= 300) throw new Error(`processDiagramGet: HTTP ${bin.status}`);
    return { svg: bin.buffer.toString('utf8'), bytes: bin.buffer.length };
  }

  /**
   * P1#15 — Baixa o BINÁRIO de um anexo da solicitação.
   * ⚠️ Bug do produto (confirmado no bytecode): na rota PLURAL downloadAttachments os parâmetros
   *    `user` e `replacedUser` estão AMBOS anotados @QueryParam("user"). Por isso esta função usa
   *    só a rota singular e NÃO expõe replacedUser — ali ele não teria efeito.
   */
  async attachmentDownload(processInstanceId, attachmentSequence, destino) {
    const p = `/process-management/api/v2/requests/${encodeURIComponent(processInstanceId)}`
      + `/attachments/${encodeURIComponent(attachmentSequence)}/download`;
    return this._salvar(destino, await this._restBinary(p), 'attachmentDownload');
  }

  /**
   * P1#16 — Nomes de campo VÁLIDOS de um formulário. Pré-requisito de todas as tools de card:
   * sem isto, escrever card é adivinhar nome de campo.
   * ⚠️ A ordem dos argumentos SOAP INVERTE entre serviços: ECMCardIndexService recebe
   *    (username, password, companyId, ...) enquanto ECMCardService recebe companyId primeiro.
   *    Em RPC posicional errar não dá erro de compilação — dá resultado errado.
   * ⚠️ O campo chama-se `field` no SOAP e `fieldId` no REST v2.
   */
  async formFields(documentId) {
    const c = await this._soapClient('/webdesk/ECMCardIndexService?wsdl');
    const [res] = await retry(() => c.getFormFieldsAsync({
      username: this.user, password: this.pass, companyId: this.companyId, documentId: Number(documentId),
    }));
    const it = res?.item ?? res?.result?.item ?? res?.return?.item ?? res;
    const campos = Array.isArray(it) ? it : (it ? [it] : []);
    return { documentId: Number(documentId), total: campos.length, campos };
  }

  /**
   * P1#17 — Cria/altera/apaga registro de formulário e LINHAS FILHAS, headless.
   * ⚠️ A rota de leitura é `childrens` (plural) e a de escrita é `children` (singular) —
   *    confirmado na spec do WAR. Trocar uma pela outra dá 404.
   * ⚠️ DELETE é destrutivo e exige confirm.
   */
  async cardSave({ documentId, cardId, rowId, dados, acao = 'criar' }, opts = {}) {
    if (opts.confirm !== true) throw new Error('cardSave exige { confirm:true } — escreve no formulário.');
    const base = `/ecm-forms/api/v2/cardindex/${encodeURIComponent(documentId)}/cards`;
    let path, method;
    if (acao === 'criar')            { path = base; method = 'POST'; }
    else if (acao === 'atualizar')   { path = `${base}/${encodeURIComponent(cardId)}`; method = 'PUT'; }
    else if (acao === 'apagar')      { path = `${base}/${encodeURIComponent(cardId)}`; method = 'DELETE'; }
    else if (acao === 'criarLinha')  { path = `${base}/${encodeURIComponent(cardId)}/children`; method = 'POST'; }
    else if (acao === 'editarLinha') { path = `${base}/${encodeURIComponent(cardId)}/children/${encodeURIComponent(rowId)}`; method = 'PUT'; }
    else if (acao === 'apagarLinha') { path = `${base}/${encodeURIComponent(cardId)}/children/${encodeURIComponent(rowId)}`; method = 'DELETE'; }
    else throw new Error(`cardSave: ação desconhecida "${acao}".`);

    const r = await this._restRaw(path, {
      method,
      accept: 'application/json',
      contentType: dados ? 'application/json' : undefined,
      body: dados ? JSON.stringify(dados) : undefined,
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`cardSave(${acao}): HTTP ${r.status} — ${String(r.text).slice(0, 400)}`);
    }
    let corpo = r.text; try { corpo = JSON.parse(r.text); } catch { /* 204 sem corpo é normal */ }
    return { ok: true, acao, documentId, cardId, rowId, status: r.status, resposta: corpo || '(sem corpo)' };
  }

  /**
   * P1#18 — Navega o GED (pastas e documentos).
   * ⚠️ `order` é OBRIGATÓRIO na spec: sem ele a rota devolve 500 (IndexOutOfBounds), não 400.
   *    Valores seguros: documentDescription, lastModifiedDate, documentId, priority, size, favorite
   *    (prefixo `-` inverte). ⚠️ pageSize default aqui é 100.
   */
  async gedList(parentId, { order = 'documentDescription', pageSize = 100, page } = {}) {
    const qs = this._qs({ order, pageSize, page });
    const r = this._assertJson(
      await this._rest(`/content-management/api/v2/folders/${encodeURIComponent(parentId)}/documents${qs}`),
      'gedList');
    // ⚠️ Esta rota devolve o formato de grid ANTIGO: a lista vem em `invdata`, não em `items`.
    // Sem normalizar, uma pasta cheia parece vazia para quem procura `items`/`content`.
    // ⚠️ `totalrecords` NÃO é o total de documentos (vem 4 mesmo com totalpages=2) — não confie nele.
    const docs = Array.isArray(r?.invdata) ? r.invdata : [];
    return {
      pasta: parentId,
      paginaAtual: r?.currpage,
      totalPaginas: r?.totalpages,
      retornados: docs.length,
      documentos: docs.map(d => ({
        documentId: d.documentId, descricao: d.documentDescription,
        tipo: d.documentType === '1' ? 'pasta' : d.documentType,
        versao: d.version, paiId: d.parentDocumentId, publicadoPor: d.publisherId,
      })),
    };
  }

  /** P1#18b — Breadcrumb: resolve o caminho de um documento a partir da raiz. */
  async gedPath(documentId, rootId = 1) {
    return this._assertJson(
      await this._rest(`/content-management/api/v2/folders/${encodeURIComponent(rootId)}/${encodeURIComponent(documentId)}`),
      'gedPath');
  }

  /**
   * P1#19 — Baixa o conteúdo de um documento do GED.
   * ⚠️ O Content-Type do /stream NÃO é confiável: a spec declara octet-stream mas a implementação
   *    termina no mesmo helper dos thumbnails. Use Content-Disposition e a extensão do nome.
   */
  async gedDownload(documentId, destino) {
    const meta = await this._rest(`/content-management/api/v2/documents/${encodeURIComponent(documentId)}`);
    const bin = await this._restBinary(`/content-management/api/v2/documents/${encodeURIComponent(documentId)}/stream`);
    const salvo = this._salvar(destino, bin, 'gedDownload');
    return { ...salvo, metadados: meta && !meta._raw ? meta : undefined };
  }

  /**
   * P1#20 — FORENSE de solicitação travada: o que o motor tentou, com qual payload.
   * ⚠️ Passa por dbQuery, que GRAVA um dataset (ver a ressalva lá). Em produção exige confirm.
   */
  async processErrorLog(processInstanceId, opts = {}) {
    const id = Number(processInstanceId);
    if (!Number.isFinite(id)) throw new Error('processErrorLog: processInstanceId precisa ser numérico.');
    const sql = 'SELECT TOP 50 * FROM PROCES_WORKFLOW_ERROR_LOG WITH(NOLOCK) '
      + `WHERE INSTANCE_ID = ${id} ORDER BY 1 DESC`;
    return this.dbQuery(sql, opts);
  }

  /**
   * P1#21 — Cria um formulário (fichário) novo, headless.
   * `parentId` é a pasta do GED onde o formulário nasce — descubra com gedList.
   */
  async formCreate({ formName, parentId, zipPath }, opts = {}) {
    if (opts.confirm !== true) throw new Error('formCreate exige { confirm:true } — cria documento no GED.');
    if (!zipPath) throw new Error('formCreate: informe zipPath (ZIP com o HTML do formulário).');
    const arquivo = readFileSync(zipPath);
    const fd = new FormData();
    fd.append('file', new Blob([arquivo]), zipPath.split(/[\\/]/).pop());
    fd.append('formName', String(formName));
    fd.append('parentId', String(parentId));
    const cookie = await this.login();
    const r = await this._fetch('/ecm-forms/api/v2/cardindex', {
      method: 'POST', headers: { Cookie: cookie, Accept: 'application/json' }, body: fd,
    });
    const texto = await r.text();
    if (r.status < 200 || r.status >= 300) throw new Error(`formCreate: HTTP ${r.status} — ${texto.slice(0, 400)}`);
    try { return JSON.parse(texto); } catch { return { ok: true, status: r.status, resposta: texto }; }
  }

  /**
   * P1#22 — Migra solicitações ABERTAS da versão antiga para a nova, atividade a atividade.
   * ⚠️ A OPERAÇÃO MAIS DESTRUTIVA DO MCP. Converter FINALIZA as tarefas pendentes e cria novas no
   *    destino: mapeamento errado = trabalho em curso perdido, sem volta.
   * ⚠️ Não aparece no Swagger (@ApiOperation(hidden=true)) — path confirmado no bytecode.
   * ⚠️ Tudo vai em QUERY STRING, sem corpo, com os parâmetros REPETIDOS.
   * `actualStates` e `newStates` são pares posicionais: o i-ésimo actual vira o i-ésimo new.
   */
  async convertProcessInstances({ processInstanceId, newVersion, actualStates, newStates }, opts = {}) {
    const inst = Array.isArray(processInstanceId) ? processInstanceId : [processInstanceId];
    const de = Array.isArray(actualStates) ? actualStates : [actualStates];
    const para = Array.isArray(newStates) ? newStates : [newStates];
    if (de.length !== para.length) {
      throw new Error(`convertProcessInstances: actualStates (${de.length}) e newStates (${para.length}) precisam ter o MESMO tamanho — são pares posicionais.`);
    }
    const plano = {
      instancias: inst, novaVersao: newVersion,
      mapeamento: de.map((d, i) => `${d} -> ${para[i]}`),
      aviso: 'Converter FINALIZA as tarefas pendentes e cria novas no destino. Irreversível.',
    };
    if (opts.dryRun !== false && opts.confirm !== true) return { dryRun: true, ...plano };
    if (opts.confirm !== true) throw new Error('convertProcessInstances exige { confirm:true } após revisar o dryRun.');
    const qs = this._qs({ processInstanceId: inst, newVersion, actualStates: de, newStates: para });
    const r = await this._restRaw(`/process-management/api/v2/processes/convertProcess${qs}`,
      { method: 'POST', accept: 'application/json' });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`convertProcessInstances: HTTP ${r.status} — ${String(r.text).slice(0, 400)}`);
    }
    return { ok: true, ...plano, status: r.status, resposta: r.text || '(sem corpo)' };
  }

  // =====================================================================================
  // ONDA P2 — alcance: SLA, GED, integração e escrita no RM pela business layer
  // =====================================================================================

  /**
   * P2#23 — Heatmap: quantas instâncias paradas em cada atividade + contadores de SLA.
   * ⚠️ Só esta rota `/resume` aceita expand/interactives — não generalize para as irmãs.
   */
  async activitiesResume(processId, processVersion, { interactives = true, expand } = {}) {
    const qs = this._qs({ interactives, expand: expand || ['state.configuration'] });
    const p = `/process-management/api/v2/processes/${encodeURIComponent(processId)}`
      + `/process-versions/${encodeURIComponent(processVersion)}/states/activities/resume${qs}`;
    const r = await this._rest(p);
    // ⚠️ MEDIDO EM PRODUÇÃO (24/09/2026): esta rota funciona em alguns processos (WRH14_MovimentoFolha,
    //    WSUP05) e devolve javax.ejb.EJBException em outros (WAP01, aberturaDeVaga) — com ou sem
    //    expand/interactives, inclusive sem query nenhuma. É falha DO PRODUTO para certos processos,
    //    não da chamada. Sem esta mensagem, o EJBException vazio manda o dev caçar erro no lugar errado.
    if (r && /EJBException/i.test(r.code || '')) {
      throw new Error(
        `activitiesResume(${processId} v${processVersion}): o servidor devolveu javax.ejb.EJBException. `
        + 'Esta rota falha assim em ALGUNS processos, independente dos parâmetros (confirmado em produção '
        + 'em 24/09/2026). Não é erro da chamada. Alternativa: fluig_task_list / fluig_request_list '
        + 'filtrando por processo, que dão a mesma leitura de "o que está parado onde".'
      );
    }
    return this._assertJson(r, 'activitiesResume');
  }

  /**
   * P2#24 — Prazo em HORÁRIO ÚTIL, pelo calendário do servidor.
   * ⚠️ Esta API trabalha em SEGUNDOS, enquanto o `deadlineTime` do modelo de processo é gravado em
   *    MINUTOS. Passar um pelo outro erra o prazo por 60×. A conversão fica explícita aqui.
   */
  async deadlineCalc(modo, { startDate, endDate, duration, duracaoEmMinutos, localId, periodId } = {}) {
    const rotas = { duracao: 'duration', fim: 'end-date', inicio: 'start-date' };
    const rota = rotas[modo];
    if (!rota) throw new Error(`deadlineCalc: modo inválido "${modo}". Use duracao | fim | inicio.`);
    // ⚠️ O parâmetro obrigatório chama-se `seconds`, NÃO `duration` (o plano de evolução errava isso;
    //    a spec extraída do WAR corrige). Mandar `duration` fazia o servidor devolver
    //    NullPointerException — erro que parece bug do produto e é parâmetro faltando.
    const seg = duracaoEmMinutos !== undefined ? Number(duracaoEmMinutos) * 60 : duration;
    const falta = [];
    if (modo === 'duracao')      { if (!startDate) falta.push('startDate'); if (!endDate) falta.push('endDate'); }
    else if (modo === 'fim')     { if (!startDate) falta.push('startDate'); if (seg === undefined) falta.push('seconds (duration/duracaoEmMinutos)'); }
    else                         { if (!endDate) falta.push('endDate');     if (seg === undefined) falta.push('seconds (duration/duracaoEmMinutos)'); }
    if (falta.length) throw new Error(`deadlineCalc(${modo}): faltam parâmetros obrigatórios: ${falta.join(', ')}.`);
    const qs = this._qs({ startDate, endDate, seconds: seg, localId, periodId });
    const r = this._assertJson(
      await this._rest(`/process-management/api/v2/date-calculator/${rota}${qs}`), 'deadlineCalc');
    return { modo, unidadeDaApi: 'segundos', enviado: { startDate, endDate, seconds: seg, localId, periodId }, resultado: r };
  }

  /**
   * P2#25 — Dossiê completo de uma solicitação num artefato só.
   * ⚠️ `anonymizeForms` tem default TRUE no servidor: sem escolher, o dossiê vem anonimizado e você
   *    perde tempo achando que o dado sumiu. Por isso aqui a escolha é OBRIGATÓRIA.
   */
  async workflowExporter(processInstanceId, { anonymizeForms, destino } = {}) {
    if (typeof anonymizeForms !== 'boolean') {
      throw new Error('workflowExporter: informe anonymizeForms (true|false) explicitamente — o default do servidor é TRUE e anonimiza os formulários em silêncio.');
    }
    const qs = this._qs({ anonymizeForms });
    const base = `/process-management/api/v2/workflow-exporter/${encodeURIComponent(processInstanceId)}`;
    if (destino) {
      return this._salvar(destino, await this._restBinary(`${base}/download${qs}`, { accept: 'application/zip' }), 'workflowExporter');
    }
    const r = await this._restRaw(`${base}${qs}`, { accept: 'text/plain' });
    if (r.status < 200 || r.status >= 300) throw new Error(`workflowExporter: HTTP ${r.status} — ${String(r.text).slice(0, 300)}`);
    return { processInstanceId, anonymizeForms, tamanho: r.text.length, dossie: r.text.slice(0, 6000) };
  }

  /**
   * P2#26 — Sobe arquivo para o GED.
   * ⚠️ Use SEMPRE a rota de UMA chamada. A de duas etapas (upload + publish) renomeia o arquivo para
   *    `[epoch]nome` e o publish descarta campos em silêncio.
   */
  async gedUpload(caminhoLocal, parentId, opts = {}) {
    if (opts.confirm !== true) throw new Error('gedUpload exige { confirm:true } — publica documento no GED.');
    const nome = opts.nomeArquivo || caminhoLocal.split(/[\\/]/).pop();
    const conteudo = readFileSync(caminhoLocal);
    const fd = new FormData();
    fd.append('file', new Blob([conteudo]), nome);
    const cookie = await this.login();
    const p = `/content-management/api/v2/documents/upload/${encodeURIComponent(nome)}/${encodeURIComponent(parentId)}/publish`;
    const r = await this._fetch(p, { method: 'POST', headers: { Cookie: cookie, Accept: 'application/json' }, body: fd });
    const texto = await r.text();
    if (r.status < 200 || r.status >= 300) throw new Error(`gedUpload: HTTP ${r.status} — ${texto.slice(0, 400)}`);
    try { return JSON.parse(texto); } catch { return { ok: true, status: r.status, arquivo: nome, resposta: texto }; }
  }

  /**
   * P2#27 — URL renderizada de uma ficha, com token de acesso.
   * ⚠️ A rota é @Produces(text/plain): com Accept JSON dá 500 NotAcceptableException.
   * ⚠️ A URL contém TOKEN DE ACESSO ao documento — não logar nem repassar adiante.
   */
  async cardHtmlUrl(params = {}) {
    const r = await this._restRaw(`/ecm-forms/api/v2/cardindex/html${this._qs(params)}`, { accept: 'text/plain' });
    if (r.status < 200 || r.status >= 300) throw new Error(`cardHtmlUrl: HTTP ${r.status} — ${String(r.text).slice(0, 300)}`);
    return { url: r.text.trim(), aviso: 'Esta URL carrega token de acesso ao documento — não compartilhe nem registre em log.' };
  }

  /**
   * P2#28 — Serviços de integração cadastrados (nome exato, URL, tipo, driver).
   * ⚠️ NUNCA selecionar coluna de credencial aqui. A projeção é fixa de propósito — não aceita
   *    campos do chamador, para que ninguém transforme esta tool em vazador de senha.
   */
  async serviceList(opts = {}) {
    const sql = 'SELECT NOM_SERV_DADOS, NOM_URL_SERV, IDI_TIP_SERV, DRIVER, WS_ENGINE '
      + 'FROM SERV_DADOS WITH(NOLOCK) ORDER BY NOM_SERV_DADOS';
    return this.dbQuery(sql, opts);
  }

  /**
   * P2#29 — Ativa / inativa / converte para CUSTOM um dataset.
   * ⚠️ `disable` é LÓGICO (IS_ACTIVE=false), não é o delete físico — não confundir com deleteDataset.
   * ⚠️ E não confundir com AGENDAMENTO: isto é o flag `active`, não o `serverOffline`.
   *    Um dataset ativo e sem serverOffline continua sem sincronizar.
   */
  async datasetStateSet(datasetId, acao, opts = {}) {
    if (opts.confirm !== true) throw new Error('datasetStateSet exige { confirm:true } — altera o estado do dataset no servidor.');
    const id = encodeURIComponent(datasetId);
    const rotas = {
      ativar:    { path: `/dataset/api/v1/datasets/active/${id}`,  method: 'PUT' },
      desativar: { path: `/dataset/api/v1/datasets/disable/${id}`, method: 'PUT' },
      converter: { path: `/dataset/api/v2/datasets/convert/${id}`, method: 'POST' },
    };
    const r0 = rotas[acao];
    if (!r0) throw new Error(`datasetStateSet: ação inválida "${acao}". Use ativar | desativar | converter.`);
    const r = await this._restRaw(r0.path, { method: r0.method, accept: 'application/json' });
    if (r.status < 200 || r.status >= 300) throw new Error(`datasetStateSet(${acao}): HTTP ${r.status} — ${String(r.text).slice(0, 300)}`);
    return { ok: true, datasetId, acao, status: r.status, resposta: r.text || '(sem corpo)' };
  }

  /**
   * P2#30 — Move pela REST v2: retorno tipado e tratamento explícito do 412.
   * ⚠️ Campos int primitivos (targetState, subProcessTargetState, movementSequence): OMITIR envia 0,
   *    nunca null. Com gateway no fluxo, informe targetState sempre.
   * ⚠️ A semântica de `formFields` NÃO está confirmada (pode ser merge ou substituição). Até alguém
   *    provar num processo descartável, trate como SUBSTITUIÇÃO e mande o card completo — igual ao SOAP.
   * ⚠️ 412 não é erro de transporte: é "destinatário/estado inválido", e o corpo traz o MoveResponse
   *    com as opções. Por isso o 412 é devolvido como DADO, não como exceção.
   */
  async moveRest(processInstanceId, corpo, opts = {}) {
    if (opts.confirm !== true) throw new Error('moveRest exige { confirm:true } — movimenta a solicitação.');
    const r = await this._restRaw(`/process-management/api/v2/requests/${encodeURIComponent(processInstanceId)}/move`, {
      method: 'POST', accept: 'application/json',
      contentType: 'application/json', body: JSON.stringify(corpo || {}),
    });
    let dados = r.text; try { dados = JSON.parse(r.text); } catch { /* pode vir vazio */ }
    if (r.status === 412) {
      return { ok: false, http412: true, motivo: 'destinatário ou estado destino inválido — veja as opções e use fluig_process_possible_assignees', resposta: dados };
    }
    if (r.status < 200 || r.status >= 300) throw new Error(`moveRest: HTTP ${r.status} — ${String(r.text).slice(0, 400)}`);
    return { ok: true, processInstanceId, status: r.status, resposta: dados };
  }

  /** P2#31 — Esqueleto de processo novo (útil para processo descartável de teste). */
  async processCreate({ processId, processDescription, categoryId, formId }, opts = {}) {
    if (opts.confirm !== true) throw new Error('processCreate exige { confirm:true } — cria definição de processo.');
    if (!processId || !processDescription) throw new Error('processCreate: processId e processDescription são obrigatórios (a spec marca o body como opcional, mas sem eles não nasce nada usável).');
    const r = await this._restRaw('/process-management/api/v2/processes', {
      method: 'POST', accept: 'application/json', contentType: 'application/json',
      body: JSON.stringify({ processId, processDescription, categoryId, formId }),
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`processCreate: HTTP ${r.status} — ${String(r.text).slice(0, 400)}`);
    let dados = r.text; try { dados = JSON.parse(r.text); } catch { /* noop */ }
    return { ok: true, processId, status: r.status, resposta: dados };
  }

  /**
   * P2#32 — Contrato (schema) de um DataServer do RM, ANTES de tentar gravar.
   * Roda de dentro de um dataset (padrão MIP), via ServiceManager → wsDataServer.getSchema.
   * ⚠️ Grava um dataset para executar (mesma ressalva do dbQuery).
   */
  async rmDataServerSchema(dataServerName, contexto, opts = {}) {
    this._guardProdWrite('rmDataServerSchema', opts, 'ds_claude_rm_schema');
    const ctx = contexto || 'CODCOLIGADA=1;CODSISTEMA=G;CODUSUARIO=mestre';
    const code =
      'function createDataset(fields, constraints, sortFields){'
      + 'var nd=DatasetBuilder.newDataset();nd.addColumn("SCHEMA");'
      + 'try{var sm=new com.totvs.technology.ecm.dataservice.cs.ServiceManager();'
      + 'var svc=sm.getService("wsDataServer");'
      + 'var lo=svc.instantiate("com.totvs.WsDataServer.IwsDataServer");'
      + 'var r=lo.getSchema(' + JSON.stringify(dataServerName) + ',' + JSON.stringify(ctx) + ');'
      + 'nd.addRow(new Array(""+r));}'
      + 'catch(e){nd.addColumn("ERRO");nd.addRow(new Array(""+e));}return nd;}';
    await this.saveDataset('ds_claude_rm_schema', code, 'Claude rmDataServerSchema (leitura de contrato)');
    return this.runDataset('ds_claude_rm_schema');
  }

  /**
   * P2#33 — Grava no RM pela BUSINESS LAYER (DataServer), não por SQL cru.
   * É a forma CERTA de escrever no ERP: respeita fórmula, consistência, numeração e rateio —
   * tudo que um UPDATE direto atropela.
   * 🛑 Maior risco do conjunto. Exige dryRun revisado e confirm. Só use depois que
   *    rmDataServerSchema provar que a credencial de integração está boa e o contrato é o esperado.
   */
  async rmSaveRecord(dataServerName, xml, contexto, opts = {}) {
    const ctx = contexto || 'CODCOLIGADA=1;CODSISTEMA=G;CODUSUARIO=mestre';
    if (opts.confirm !== true) {
      return {
        dryRun: true, dataServer: dataServerName, contexto: ctx,
        xmlTamanho: String(xml || '').length,
        xmlPreview: String(xml || '').slice(0, 800),
        aviso: 'ESCRITA NO ERP. Revise o XML contra o contrato (fluig_rm_dataserver_schema) e só então confirme.',
      };
    }
    this._guardProdWrite('rmSaveRecord', opts, 'ds_claude_rm_save');
    const code =
      'function createDataset(fields, constraints, sortFields){'
      + 'var nd=DatasetBuilder.newDataset();nd.addColumn("RESULTADO");'
      + 'try{var sm=new com.totvs.technology.ecm.dataservice.cs.ServiceManager();'
      + 'var svc=sm.getService("wsDataServer");'
      + 'var lo=svc.instantiate("com.totvs.WsDataServer.IwsDataServer");'
      + 'var r=lo.saveRecord(' + JSON.stringify(dataServerName) + ',' + JSON.stringify(String(xml)) + ',' + JSON.stringify(ctx) + ');'
      + 'nd.addRow(new Array(""+r));}'
      + 'catch(e){nd.addColumn("ERRO");nd.addRow(new Array(""+e));}return nd;}';
    await this.saveDataset('ds_claude_rm_save', code, 'Claude rmSaveRecord (ESCRITA no ERP via DataServer)');
    return this.runDataset('ds_claude_rm_save');
  }

  /**
   * P0#5 — Lista solicitações. Traz `formRecordId` (= cardId) e `formId` SEM expand:
   * é a ponte BPM→formulário. ⚠️ aqui `processId` é ARRAY repetido (≠ /v2/tasks).
   */
  async requestList({ pageSize = 100, ...params } = {}) {
    const qs = this._qs({ pageSize, ...params });
    return this._assertJson(await this._rest(`/process-management/api/v2/requests${qs}`), 'requestList');
  }

  /**
   * P0#6 — Registros (cards) de um formulário, sem BPM e sem SQL.
   * ⚠️ `pageSize` default AQUI é 100, não 1000 como no BPM.
   */
  async cardList(documentId, { pageSize = 100, ...params } = {}) {
    const qs = this._qs({ pageSize, ...params });
    return this._assertJson(
      await this._rest(`/ecm-forms/api/v2/cardindex/${encodeURIComponent(documentId)}/cards${qs}`), 'cardList');
  }

  /**
   * P0#7 — Linhas pai-filho de um card, COM rowId/tableId (o que o card achatado não dá).
   * ⚠️ A ordem NÃO é determinística — ordene por rowId no cliente. É o que esta função faz.
   */
  async cardChildren(documentId, cardId, params = {}) {
    const qs = this._qs(params);
    const r = this._assertJson(await this._rest(
      `/ecm-forms/api/v2/cardindex/${encodeURIComponent(documentId)}/cards/${encodeURIComponent(cardId)}/childrens${qs}`),
      'cardChildren');
    const items = r?.items || r?.content || r;
    if (Array.isArray(items)) {
      items.sort((a, b) => Number(a?.rowId ?? 0) - Number(b?.rowId ?? 0));
    }
    return r;
  }

  /**
   * P0#8 — Histórico de versões de um dataset, com o fonte. O "git log" embutido.
   * ⚠️ DatasetHistoryRest NÃO aplica `fields`/`expand` (confirmado no bytecode: nenhum @ApiFilter),
   *    então cada item vem com o datasetImpl integral (~8 KB). Por isso pageSize é baixo por
   *    padrão e o fonte vem TRUNCADO salvo truncar:false.
   */
  async datasetHistory(datasetId, { pageSize = 3, order = '-version', truncar = true, limiteFonte = 1200 } = {}) {
    const qs = this._qs({ datasetId, order, pageSize });
    const r = this._assertJson(await this._rest(`/dataset/api/v2/dataset-history${qs}`), 'datasetHistory');
    const items = r?.items || r?.content;
    if (truncar && Array.isArray(items)) {
      for (const it of items) {
        if (typeof it?.datasetImpl === 'string' && it.datasetImpl.length > limiteFonte) {
          it._fonteTamanho = it.datasetImpl.length;
          it.datasetImpl = it.datasetImpl.slice(0, limiteFonte) + `\n/* …truncado (${it.datasetImpl.length} chars). Use truncar:false p/ o fonte inteiro. */`;
        }
      }
    }
    return r;
  }

  /** P0#9 — Existe rascunho pendente neste dataset? Guarda-corpo ANTES de sobrescrever. */
  async datasetDraftCheck(datasetId) {
    const qs = this._qs({ datasetId });
    return this._assertJson(
      await this._rest(`/dataset/api/v2/dataset-history/restore/validation${qs}`), 'datasetDraftCheck');
  }

  /**
   * P0#10 — Rollback de dataset para uma versão anterior.
   * Não é destrutivo: a versão atual continua no histórico. ⚠️ A spec declara 202, mas responde 201.
   */
  async datasetRestore(datasetId, version, opts = {}) {
    if (opts.confirm !== true) throw new Error('datasetRestore exige { confirm:true } — troca o código do dataset no servidor.');
    const qs = this._qs({ datasetId, version });
    const r = await this._restRaw(`/dataset/api/v2/dataset-history/restore${qs}`, { method: 'POST', accept: 'application/json' });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`datasetRestore(${datasetId} v${version}): HTTP ${r.status} — ${String(r.text).slice(0, 300)}`);
    }
    return { ok: true, datasetId, versaoRestaurada: version, status: r.status, resposta: r.text || '(sem corpo)' };
  }
}
