/**
 * Configuração — lida inteiramente do ambiente.
 *
 * NÃO existe default de host nem de credencial, de propósito. Uma ferramenta que já vem com
 * um endpoint embutido é vazamento esperando acontecer, e senha default nunca é a resposta
 * certa: variável faltando é erro explícito, nunca fallback silencioso para o servidor de
 * outra pessoa.
 *
 * DOIS AMBIENTES. Este servidor atende homologação e produção ao mesmo tempo, e toda chamada
 * escolhe o alvo pelo parâmetro `env` ("teste" | "prod"). O motivo é operacional: com um
 * default silencioso, quem pedia produção lia homologação e reportava o número errado como
 * se fosse de produção. Configure só o par de teste, só o de prod, ou os dois.
 *
 *   Homologação:  FLUIG_HOST       FLUIG_USER        FLUIG_PASS
 *   Produção:     FLUIG_HOST_PROD  FLUIG_USER_PROD   FLUIG_PASS_PROD
 *
 * No lugar da senha, FLUIG_PASS_CMD / FLUIG_PASS_CMD_PROD: um comando que a imprime, para ela ficar no
 * cofre do sistema e não em texto puro no config do cliente MCP (ver senhaDoComando).
 *
 * ⚠️ A credencial de produção NÃO cai na de homologação. Esse fallback existia e era uma
 *    armadilha: mandava a senha de homologação contra produção e queimava tentativas do
 *    Active Directory — o suficiente para bloquear a conta do usuário.
 */

import { execFileSync } from 'node:child_process';

const TRUTHY = /^(1|true|yes|on)$/i;

/**
 * Divide a linha de comando de FLUIG_PASS_CMD em argumentos, respeitando aspas simples e duplas.
 * Sem shell de propósito: o comando roda com execFile, então `;`, `|` e `$()` são texto, não código.
 */
export function dividirComando(texto) {
  const partes = [];
  let atual = '';
  let aspas = null;
  let temParte = false;
  for (const ch of String(texto).trim()) {
    if (aspas) {
      if (ch === aspas) aspas = null;
      else atual += ch;
    } else if (ch === '"' || ch === "'") {
      aspas = ch;
      temParte = true;
    } else if (/\s/.test(ch)) {
      if (temParte) partes.push(atual);
      atual = '';
      temParte = false;
    } else {
      atual += ch;
      temParte = true;
    }
  }
  if (aspas) throw new Error(`Comando com aspas sem fechar: ${texto}`);
  if (temParte) partes.push(atual);
  return partes;
}

/**
 * Por que o comando falhou, sem nunca incluir o stdout: num comando que imprimiu a senha e depois saiu
 * com erro, o stdout é a própria senha. O stderr é o que explica a falha ("not signed in", "No secret
 * key"), então vai junto, numa linha e cortado.
 */
function motivoDaFalha(e) {
  if (e.code === 'ETIMEDOUT') return 'não respondeu em 15 s; o cofre está esperando ser desbloqueado?';
  let motivo = String(e.status ?? e.code ?? e.signal ?? 'erro desconhecido');
  // No Windows, .cmd/.bat (o formato das CLIs instaladas pelo npm) não rodam sem shell desde o
  // CVE-2024-27980 (EINVAL), e o PATH sem shell só acha .exe/.com (ENOENT): o código sozinho não ajuda.
  if (process.platform === 'win32' && (e.code === 'EINVAL' || e.code === 'ENOENT')) {
    motivo += '; no Windows, .cmd/.bat não rodam sem shell: aponte para o .exe ou use '
      + 'powershell.exe -NoProfile -Command "..." (veja docs/clientes.md)';
  }
  const erro = String(e.stderr ?? '').replace(/\s+/g, ' ').trim();
  if (!erro) return motivo;
  return `${motivo}: ${erro.length > 200 ? `${erro.slice(0, 200)}…` : erro}`;
}

/**
 * Senha lida da saída de um comando (secret-tool, security, pass, op...). Assim ela fica no cofre do
 * sistema e não em texto puro no JSON do cliente MCP. Falha aqui é erro ANTES de qualquer login:
 * tentar com senha vazia ou errada queimaria uma das tentativas do AD.
 */
function senhaDoComando(linha, variavel) {
  const [cmd, ...args] = dividirComando(linha);
  if (!cmd) throw new Error(`${variavel} está vazia.`);
  let saida;
  try {
    // windowsHide: chamado por um cliente MCP sem console, o powershell.exe abriria uma janela piscando.
    saida = execFileSync(cmd, args, {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch (e) {
    throw new Error(`${variavel}: o comando falhou (${motivoDaFalha(e)}) — não vou tentar o login.`);
  }
  // Só a primeira linha: é a convenção do pass/gopass (as seguintes são metadados como "login:"), e
  // mandar a saída inteira gastaria uma tentativa do AD com a senha errada.
  const senha = saida.split(/\r?\n/, 1)[0];
  if (!senha) throw new Error(`${variavel}: a primeira linha da saída do comando está vazia — não vou tentar o login.`);
  // U+FFFD é byte que não era UTF-8: no Windows, o PowerShell 5.1 escreve no code page do console, e
  // uma senha com acento chegaria trocada ao login.
  if (senha.includes('�')) {
    throw new Error(
      `${variavel}: a saída do comando não é UTF-8 válido — não vou tentar o login. No PowerShell, `
      + 'comece com [Console]::OutputEncoding = [Text.Encoding]::UTF8 (veja docs/clientes.md).',
    );
  }
  return senha;
}

/** Valida e normaliza a URL base do portal. */
function parseHost(valor, variavel) {
  const host = String(valor).trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(host);
  } catch {
    throw new Error(`${variavel} não é uma URL válida: ${host}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${variavel} precisa usar http ou https — recebi: ${url.protocol}`);
  }
  return host;
}

/** Quais ambientes têm host configurado. Usado para validar antes de subir o servidor. */
export function ambientesConfigurados(env = process.env) {
  const out = [];
  if (env.FLUIG_HOST) out.push('teste');
  if (env.FLUIG_HOST_PROD) out.push('prod');
  return out;
}

/**
 * Lê a configuração de um ambiente.
 *
 * @param {'teste'|'prod'} alvo
 * @param {NodeJS.ProcessEnv} [env] injetável para teste
 * @throws {Error} quando falta host ou credencial daquele ambiente
 */
export function loadConfig(alvo = 'teste', env = process.env) {
  if (alvo !== 'teste' && alvo !== 'prod') {
    throw new Error(`Ambiente inválido: "${alvo}". Use "teste" ou "prod".`);
  }
  const isProd = alvo === 'prod';
  const vHost = isProd ? 'FLUIG_HOST_PROD' : 'FLUIG_HOST';
  const vUser = isProd ? 'FLUIG_USER_PROD' : 'FLUIG_USER';
  const vPass = isProd ? 'FLUIG_PASS_PROD' : 'FLUIG_PASS';
  const vCmd = isProd ? 'FLUIG_PASS_CMD_PROD' : 'FLUIG_PASS_CMD';
  const definida = (k) => !!env[k] && !!String(env[k]).trim();

  if (definida(vPass) && definida(vCmd)) {
    throw new Error(`Defina ${vPass} ou ${vCmd}, não os dois: com os dois, qual senha vale ficaria escondido.`);
  }
  const faltando = [vHost, vUser].filter((k) => !definida(k));
  if (!definida(vPass) && !definida(vCmd)) faltando.push(`${vPass} (ou ${vCmd})`);
  if (faltando.length) {
    throw new Error(
      `Ambiente "${alvo}" não configurado — faltam: ${faltando.join(', ')}. `
      + 'Defina no config do seu cliente MCP ou no shell (veja .env.example). '
      + 'Não há default: um host ou senha embutidos seriam um vazamento.',
    );
  }

  const user = String(env[vUser]).trim();
  return {
    env: alvo,
    isProd,
    host: parseHost(env[vHost], vHost),
    user,
    pass: definida(vCmd) ? senhaDoComando(env[vCmd], vCmd) : String(env[vPass]),
    companyId: Number(env[isProd ? 'FLUIG_COMPANY_PROD' : 'FLUIG_COMPANY'] ?? env.FLUIG_COMPANY ?? 1),
    // Vazio = descobrir pela sessão no primeiro login (ver FluigClient._descobrirUserCode). O código
    // do colaborador costuma ser a matrícula, diferente do login; usar o login no lugar dele faz as
    // rotas SOAP que filtram por colleagueId devolverem vazio SEM erro.
    userCode: String(env[isProd ? 'FLUIG_USERCODE_PROD' : 'FLUIG_USERCODE'] || '').trim(),
    // IPs semente para quando o DNS interno oscila. São sempre TCP-probados antes de usar,
    // então um seed obsoleto é inofensivo. A requisição em si vai pelo HOSTNAME (ver _fetch).
    seedIps: String(env[isProd ? 'FLUIG_IPS_PROD' : 'FLUIG_IPS'] || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    datasource: String(env.FLUIG_DATASOURCE || '/jdbc/AppDS').trim(),
    rmDatasource: String(env.FLUIG_RM_DATASOURCE || '/jdbc/Corpore').trim(),
    rmBridgeDataset: String(env.FLUIG_RM_BRIDGE_DATASET || 'ds_generic_rm_sql').trim(),
    scratchPrefix: String(env.FLUIG_SCRATCH_PREFIX || 'ds_mcp_').trim(),
    readOnly: TRUTHY.test(String(env.FLUIG_READONLY || '')),
  };
}
