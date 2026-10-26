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
export const TIPOS = ['MUST', 'SHOULD', 'MUST_NOT'];
// O servidor lê o sqlLimit com Integer.parseInt: acima disso (ou "2.5", "1e+21") a falha SOAP não diz nada útil.
export const MAX_SERVER_LIMIT = 2 ** 31 - 1;

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

/**
 * Constraint crua: { field, initial, final, type, like }, ou os nomes do WSDL (fieldName, initialValue,
 * finalValue, contraintType, likeSearch), que é o que a extensão VS Code e quem copia do SOAP mandam.
 */
function constraintCrua(k) {
  const field = String(k?.field ?? k?.fieldName ?? '').trim();
  // Sem field, ia "undefined" como nome do campo: erro de SQL que alguns datasets engolem e devolvem vazio.
  if (!field) throw new Error('Constraint crua sem field (ou fieldName).');
  const tipoInformado = k.type ?? k.contraintType;
  const tipo = String(tipoInformado ?? 'MUST').trim().toUpperCase();
  // O SOAP transforma qualquer type desconhecido em MUST: "MUST NOT" viraria inclusão em vez de exclusão.
  if (!TIPOS.includes(tipo)) throw new Error(`Constraint "${field}" com type "${tipoInformado}" inválido. Use: ${TIPOS.join(', ')}.`);
  const inicial = String(k.initial ?? k.initialValue ?? '');
  const final = String(k.final ?? k.finalValue ?? inicial);
  // A extensão VS Code manda likeSearch como texto: !!"false" é true e a igualdade viraria "contém".
  const like = String(k.like ?? k.likeSearch).toLowerCase() === 'true';
  return constraint(field, inicial, final, tipo, like);
}

function limiteDoServidor(serverLimit) {
  if (serverLimit == null) return [];
  const n = Number(serverLimit);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SERVER_LIMIT) {
    throw new Error(`serverLimit deve ser inteiro entre 1 e ${MAX_SERVER_LIMIT}; veio "${serverLimit}".`);
  }
  return [constraint('sqlLimit', String(n), String(n), 'MUST')];
}

/** Monta fields/constraints/order do getDataset a partir dos argumentos da ferramenta. */
export function consultaDataset({ fields = [], filters, match, constraints, serverLimit, order } = {}) {
  return {
    fields,
    constraints: [
      ...lista(constraints, 'constraints').map(constraintCrua),
      ...buildConstraints(filters, match),
      ...limiteDoServidor(serverLimit),
    ],
    order: order?.field ? [order.desc ? `${order.field};desc` : order.field] : [],
  };
}

/**
 * Resposta do fluig_dataset_run. Com serverLimit, total é no máximo o teto: se o servidor devolveu o teto
 * inteiro, limitadoPeloServidor avisa que pode haver mais linhas, para o agente não reportar o teto como
 * contagem real (no 1.8, serverLimit 5 em colleague devolveu 5 das 2723 linhas).
 */
export function respostaDataset({ columns, values }, { serverLimit, limit = 0 } = {}) {
  const teto = Number(serverLimit);
  return {
    columns,
    total: values.length,
    ...(teto >= 1 && values.length >= teto ? { limitadoPeloServidor: teto } : {}),
    values: limit > 0 ? values.slice(0, limit) : values,
  };
}
