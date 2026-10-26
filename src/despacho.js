import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * O cliente Fluig da chamada de ferramenta EM CURSO.
 *
 * Antes era uma variável global que o dispatcher trocava conforme o `env` de cada chamada. O servidor
 * MCP atende chamadas simultâneas, então duas chamadas com env diferentes se misturavam: a de
 * homologação, depois do primeiro `await`, continuava no cliente de PRODUÇÃO que a outra tinha acabado
 * de instalar — e escrevia lá. Cada chamada agora roda no seu próprio contexto (AsyncLocalStorage), e
 * `client` é um encaminhador para o cliente desse contexto: os handlers continuam escrevendo
 * `client.xxx(...)` sem saber disso.
 */
const chamadaAtual = new AsyncLocalStorage();

export const client = new Proxy({}, {
  get(_, prop) {
    const alvo = chamadaAtual.getStore();
    if (!alvo) throw new Error('fluig-mcp: cliente Fluig usado fora de uma chamada de ferramenta.');
    const valor = alvo[prop];
    return typeof valor === 'function' ? valor.bind(alvo) : valor;
  },
});

/** Roda `fn` com `alvo` como o `client` de tudo que ela chamar, inclusive depois de cada await. */
export function comCliente(alvo, fn) {
  return chamadaAtual.run(alvo, fn);
}
