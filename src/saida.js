import {
  closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Texto grande (XML de processo, fonte de dataset) cabendo no contexto do agente. Medido no Fluig
 * 1.7.1: o XML de um processo real tem 142 KB, que vinham inteiros numa resposta só. Com `destino` o
 * texto vai inteiro para o arquivo e a resposta traz só o resumo, como os downloads binários já fazem.
 *
 * `destino` só vale DENTRO da pasta de saída: o conteúdo vem do servidor e o caminho vem do agente, então
 * um texto plantado no Fluig poderia induzir uma gravação em ~/.bashrc. A pasta padrão é ~/fluig-mcp-saida,
 * não a pasta onde o MCP roda: ela costuma ser o projeto do usuário, com package.json e .git/hooks graváveis
 * (sobrescrever um hook vira execução de código no próximo commit), ou "/" em clientes como o Claude Desktop
 * no macOS, onde nem dá para criar a pasta. A mesma regra vale para os downloads binários (anexo, GED,
 * diagrama, dossiê), cujo conteúdo é ainda mais controlável: qualquer usuário do Fluig sobe um anexo.
 *
 * Links não escapam:
 * - as pastas são conferidas pelo caminho REAL (realpathSync.native, que também resolve junction do
 *   Windows e devolve a caixa canônica do disco) antes e depois de criar subpastas;
 * - o arquivo é gravado num temporário novo (O_EXCL: nunca abre algo que já exista) e trocado por rename.
 *   O rename substitui a ENTRADA do diretório, então um link simbólico ou FÍSICO plantado no destino não
 *   leva a escrita para fora, e uma falha no meio não destrói o arquivo anterior.
 * Limite conhecido: entre a conferência e a gravação, outro processo com escrita na pasta de saída poderia
 * trocar uma subpasta por um link (o Node não tem openat para fechar essa janela). Fora do modelo de
 * ameaça aqui, que é o conteúdo do servidor induzindo o agente, não um processo local concorrente.
 *
 * Pasta 0700 e arquivo 0600: fonte de dataset costuma trazer credencial JDBC em texto claro, e em Linux
 * multiusuário a home pode ser legível pelos outros usuários.
 */
export const MAX_CHARS_PADRAO = 20000;

/** Início do aviso de corte. As ferramentas de escrita recusam conteúdo que o contenha (ver server.js). */
export const MARCA_CORTE = '[… cortado:';

export function pastaSaidaPadrao(env = process.env, home = homedir()) {
  return env.FLUIG_SAIDA_DIR || join(home, 'fluig-mcp-saida');
}

/** lstat que devolve null quando não existe (existsSync seguiria o link e diria que um link quebrado não existe). */
const lst = (p) => {
  try {
    return lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};

// '..' ou '..<sep>…' sai da pasta; absoluto é outro drive ou UNC. Um nome como "..config" fica dentro.
const fora = (rel) => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);

/**
 * Grava `conteudo` (string em UTF-8, ou Buffer byte a byte) em `destino`, que precisa estar dentro de
 * `base`. Caminho relativo é relativo a `base`. Devolve o caminho absoluto gravado.
 */
const recusaEm = (raiz) => (motivo = 'fora da pasta de saída') => new Error(
  `destino ${motivo} (${raiz}). Use um caminho dentro dela ou defina FLUIG_SAIDA_DIR.`,
);

/**
 * Conferência só pelo caminho, sem tocar o disco. Barata o bastante para rodar ANTES de baixar um
 * documento grande que seria recusado depois. Devolve o caminho absoluto pretendido.
 */
export function conferirDestino(destino, { base = pastaSaidaPadrao() } = {}) {
  const raiz = resolve(base);
  const recusa = recusaEm(raiz);
  if (typeof destino !== 'string' || !destino.trim()) throw recusa('inválido: informe um nome de arquivo');
  if (/[\\/]$/.test(destino)) throw recusa('precisa ser um nome de arquivo, não uma pasta');
  const arquivo = resolve(raiz, destino);
  const rel = relative(raiz, arquivo);
  if (rel === '') throw recusa('precisa ser um nome de arquivo, não a própria pasta de saída');
  if (fora(rel)) throw recusa();
  return arquivo;
}

export function gravarNaSaida(destino, conteudo, { base = pastaSaidaPadrao() } = {}) {
  const raiz = resolve(base);
  const recusa = recusaEm(raiz);
  const arquivo = conferirDestino(destino, { base });

  try {
    mkdirSync(raiz, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Error(`não consegui criar a pasta de saída ${raiz} (${e.code || e.message}). Defina FLUIG_SAIDA_DIR com uma pasta gravável.`);
  }
  const raizReal = realpathSync.native(raiz);
  const prefixo = raizReal.endsWith(sep) ? raizReal : raizReal + sep;
  const naBase = (p) => {
    let real;
    try {
      real = realpathSync.native(p);
    } catch {
      return false; // link quebrado: não dá para saber para onde iria, então não vale
    }
    return real === raizReal || real.startsWith(prefixo);
  };
  // Confere o ancestral que já existe ANTES de criar subpastas: mkdir recursivo segue links e criaria
  // pastas fora da base.
  let existente = dirname(arquivo);
  while (!lst(existente)) existente = dirname(existente);
  if (!naBase(existente)) throw recusa();
  const pasta = dirname(arquivo);
  try {
    mkdirSync(pasta, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw recusa(`inválido: não consegui criar ${pasta} (${e.code || e.message})`);
  }
  if (!naBase(pasta)) throw recusa();

  const atual = lst(arquivo);
  if (atual?.isSymbolicLink()) throw recusa(`é um link simbólico (${arquivo}); grave num arquivo comum`);
  if (atual && !atual.isFile()) throw recusa(`não é um arquivo comum (${arquivo})`);

  const tmp = join(pasta, `.${basename(arquivo)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const buf = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(String(conteudo), 'utf8');
    let gravados = 0;
    while (gravados < buf.length) gravados += writeSync(fd, buf, gravados, buf.length - gravados);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, arquivo);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return arquivo;
}

/**
 * Texto inline com teto de `maxChars` (padrão 20 000), ou inteiro em arquivo com `destino`.
 * O corte não parte par substituto UTF-16 (um emoji viraria U+FFFD no cliente).
 */
export function entregarTexto(texto, { destino, maxChars, base = pastaSaidaPadrao() } = {}) {
  const t = String(texto ?? '');
  if (destino) return { arquivo: gravarNaSaida(destino, t, { base }), caracteres: t.length };
  const n = Math.floor(Number(maxChars));
  const limite = n > 0 ? n : MAX_CHARS_PADRAO;
  if (t.length <= limite) return t;
  let corte = limite;
  const c = t.charCodeAt(corte - 1);
  if (c >= 0xd800 && c <= 0xdbff) corte -= 1;
  return `${t.slice(0, corte)}\n\n${MARCA_CORTE} ${t.length - corte} de ${t.length} caracteres omitidos. `
    + 'Informe destino para gravar o conteúdo inteiro em arquivo, ou aumente maxChars. '
    + 'Nunca salve de volta no Fluig um texto cortado.]';
}

/**
 * Recusa gravar no Fluig um texto que saiu cortado de uma leitura: get → editar → save num dataset
 * grande gravaria o código truncado, com o aviso dentro, na versão nova. Percorre objetos e listas,
 * porque o código também chega dentro de files[].content e events[].contents.
 */
export function recusarCortado(valor, campo) {
  if (typeof valor === 'string') {
    if (!valor.includes(MARCA_CORTE)) return;
    throw new Error(
      `${campo} contém o aviso de corte (${MARCA_CORTE} …): o texto veio cortado de uma leitura. `
      + 'Leia de novo com destino (arquivo inteiro) ou com maxChars maior, e grave o conteúdo completo.',
    );
  }
  if (Array.isArray(valor)) valor.forEach((v, i) => recusarCortado(v, `${campo}[${i}]`));
  else if (valor && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) recusarCortado(v, campo ? `${campo}.${k}` : k);
  }
}
