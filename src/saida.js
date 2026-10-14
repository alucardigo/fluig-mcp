import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Texto grande (XML de processo, fonte de dataset) cabendo no contexto do agente. Medido no Fluig
 * 1.7.1: o XML de um processo real tem 142 KB, que vinham inteiros numa resposta só. Com `destino` o
 * texto vai inteiro para o arquivo e a resposta traz só o resumo, como os downloads binários já fazem.
 *
 * `destino` só vale DENTRO da pasta de saída: o conteúdo vem do servidor e o caminho vem do agente, então
 * um texto plantado no Fluig poderia induzir uma gravação em ~/.bashrc. A pasta padrão é uma subpasta
 * própria (fluig-mcp-saida), não a pasta onde o MCP roda — que costuma ser o projeto do usuário, com
 * package.json e .git/hooks graváveis (sobrescrever um hook vira execução de código no próximo commit).
 * Links simbólicos não escapam: a pasta do arquivo é conferida pelo caminho real, e o arquivo é aberto
 * com O_NOFOLLOW (no Windows a constante não existe e só a primeira conferência vale).
 * Limite conhecido: entre a conferência e a abertura, outro processo com escrita na pasta de saída poderia
 * trocar uma subpasta por um link (o Node não tem openat para fechar essa janela). Fora do modelo de
 * ameaça aqui, que é o conteúdo do servidor induzindo o agente, não um processo local concorrente.
 */
export const MAX_CHARS_PADRAO = 20000;

export function pastaSaidaPadrao(env = process.env, cwd = process.cwd()) {
  return env.FLUIG_SAIDA_DIR || join(cwd, 'fluig-mcp-saida');
}

/** Existe no disco, inclusive como link quebrado (existsSync seguiria o link e diria que não). */
const existe = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
};

const dentro = (raiz, caminho) => {
  const rel = relative(raiz, caminho);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

function gravarDentro(base, destino, texto) {
  const raiz = resolve(base);
  const arquivo = resolve(raiz, String(destino));
  const recusa = () => new Error(
    `destino fora da pasta de saída (${raiz}). Use um caminho dentro dela ou defina FLUIG_SAIDA_DIR.`,
  );
  if (!dentro(raiz, arquivo)) throw recusa();
  mkdirSync(raiz, { recursive: true });
  const raizReal = realpathSync(raiz);
  const naBase = (p) => {
    let real;
    try {
      real = realpathSync(p);
    } catch {
      return false; // link quebrado: não dá para saber para onde iria, então não vale
    }
    return real === raizReal || dentro(raizReal, real);
  };
  // Confere o ancestral que já existe ANTES de criar subpastas: mkdir recursivo segue links e criaria
  // pastas fora da base.
  let existente = dirname(arquivo);
  while (!existe(existente)) existente = dirname(existente);
  if (!naBase(existente)) throw recusa();
  mkdirSync(dirname(arquivo), { recursive: true });
  if (!naBase(dirname(arquivo))) throw recusa();
  let fd;
  try {
    fd = openSync(arquivo, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o644);
  } catch (e) {
    if (e.code === 'ELOOP') throw new Error(`destino é um link simbólico (${arquivo}); grave num arquivo comum.`);
    throw e;
  }
  try {
    writeSync(fd, texto, null, 'utf8');
  } finally {
    closeSync(fd);
  }
  return arquivo;
}

export function entregarTexto(texto, { destino, maxChars, base = pastaSaidaPadrao() } = {}) {
  const t = String(texto ?? '');
  if (destino) return { arquivo: gravarDentro(base, destino, t), caracteres: t.length };
  const limite = Number(maxChars) > 0 ? Number(maxChars) : MAX_CHARS_PADRAO;
  if (t.length <= limite) return t;
  return `${t.slice(0, limite)}\n\n[… cortado: ${t.length - limite} de ${t.length} caracteres omitidos. `
    + 'Informe destino para gravar o conteúdo inteiro em arquivo, ou aumente maxChars.]';
}
