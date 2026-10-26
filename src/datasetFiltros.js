/**
 * Filtros de dataset em termos de "campo + condição + valor", traduzidos para as constraints do Fluig
 * (initialValue/finalValue, MUST/SHOULD/MUST_NOT, likeSearch). Mesma tradução da consulta de dataset do
 * Fluiggers (fluig-vscode-extension), para o agente não precisar saber que "contém" é like com %v%.
 * Medido no Fluig 1.7.1 pelo SOAP getDataset: igualdade em colleague → 1 linha; sqlLimit 5 → 5 linhas.
 * No 1.8 (homologação, colleague com 2723 linhas): starts A → 304, starts B → 52, any(A, B) → 356 = 304 + 52,
 * ou seja, SHOULD é OU de verdade; contains SILVA → 475; order desc respeitada.
 */

const LIKE = {
  contains: (v) => `%${v}%`,
  starts: (v) => `${v}%`,
  ends: (v) => `%${v}`,
};
export const OPERADORES = ['eq', 'ne', 'contains', 'starts', 'ends', 'between'];

// "contraintType" (sic) é o nome do campo no WSDL do Fluig.
const constraint = (fieldName, initialValue, finalValue, contraintType, likeSearch = false) => (
  { fieldName, initialValue, finalValue, contraintType, likeSearch }
);

// O SDK do MCP não valida o inputSchema (o enum é só dica para o modelo): o que chega aqui pode ser
// qualquer coisa, e argumento fora do esperado virando outra consulta devolve dado errado sem aviso.
const lista = (valor, nome) => {
  if (valor == null) return [];
  if (!Array.isArray(valor)) throw new Error(`${nome} deve ser uma lista (array) de objetos; veio ${typeof valor}.`);
  return valor;
};

function filtroParaConstraint(f, positiva) {
  const field = String(f?.field ?? '').trim();
  if (!field) throw new Error('Filtro sem field.');
  const { op } = f;
  // includes, não LIKE[op]: "toString" ou "constructor" achariam a propriedade herdada do protótipo.
  if (!OPERADORES.includes(op)) throw new Error(`Filtro com op "${op}" inválido. Use: ${OPERADORES.join(', ')}.`);
  // Sem value, o servidor recebe "" e filtra por campo vazio (eq) ou casa tudo com "%%" (contains).
  if (f.value == null) throw new Error(`Filtro "${field}" (${op}) sem value. Para campo vazio ou nulo use eq com value: "".`);
  const value = String(f.value);
  // O Fluig só nega no MUST_NOT, e MUST_NOT entra com E: com match any, ne continua excluindo
  // (medido no 1.8). Não existe SHOULD negado para fazer "ou diferente de".
  if (op === 'ne') return constraint(field, value, value, 'MUST_NOT');
  if (op === 'eq') return constraint(field, value, value, positiva);
  if (op === 'between') {
    const ate = String(f.valueTo ?? '');
    // Limite vazio depende do banco: fora do Oracle vira "<= ''" (nada volta); no Oracle vira null (sem limite).
    if (value === '' || ate === '') throw new Error(`between em "${field}" exige value e valueTo, os dois preenchidos.`);
    return constraint(field, value, ate, positiva);
  }
  if (value === '') throw new Error(`Filtro "${field}" (${op}) com value vazio casaria todas as linhas.`);
  // % e _ no value continuam curingas do LIKE: o Fluig monta o LIKE sem ESCAPE, então não há como escapar.
  return constraint(field, LIKE[op](value), LIKE[op](value), positiva, true);
}

/**
 * @param {{ field: string, op: string, value: string, valueTo?: string }[]} filters
 * @param {'all'|'any'} [match] all = todas (MUST); any = qualquer uma (SHOULD nas positivas)
 */
export function buildConstraints(filters = [], match = 'all') {
  const modo = String(match ?? 'all').toLowerCase();
  if (modo !== 'all' && modo !== 'any') throw new Error(`match "${match}" inválido. Use all ou any.`);
  const positiva = modo === 'any' ? 'SHOULD' : 'MUST';
  return lista(filters, 'filters').map((f) => filtroParaConstraint(f, positiva));
}

/** Monta fields/constraints/order do getDataset a partir dos argumentos da ferramenta. */
export function consultaDataset({ fields = [], filters, match, constraints = [], serverLimit, order } = {}) {
  const cruas = constraints.map((k) => constraint(
    String(k.field), String(k.initial ?? ''), String(k.final ?? k.initial ?? ''), k.type || 'MUST', !!k.like,
  ));
  const limite = Number(serverLimit) > 0 ? [constraint('sqlLimit', String(serverLimit), String(serverLimit), 'MUST')] : [];
  return {
    fields,
    constraints: [...cruas, ...buildConstraints(filters, match), ...limite],
    order: order?.field ? [order.desc ? `${order.field};desc` : order.field] : [],
  };
}
