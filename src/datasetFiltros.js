/**
 * Filtros de dataset em termos de "campo + condição + valor", traduzidos para as constraints do Fluig
 * (initialValue/finalValue, MUST/SHOULD/MUST_NOT, likeSearch). Mesma tradução da consulta de dataset do
 * Fluiggers (fluig-vscode-extension), para o agente não precisar saber que "contém" é like com %v%.
 * Medido no Fluig 1.7.1 pelo SOAP getDataset: igualdade em colleague → 1 linha; sqlLimit 5 → 5 linhas.
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

/**
 * @param {{ field: string, op: string, value?: string, valueTo?: string }[]} filters
 * @param {'all'|'any'} [match] all = todas (MUST); any = qualquer uma (SHOULD nas positivas)
 */
export function buildConstraints(filters = [], match = 'all') {
  const positiva = match === 'any' ? 'SHOULD' : 'MUST';
  return filters.map((f) => {
    const field = String(f.field ?? '').trim();
    if (!field) throw new Error('Filtro sem field.');
    const value = String(f.value ?? '');
    if (f.op === 'eq') return constraint(field, value, value, positiva);
    if (f.op === 'ne') return constraint(field, value, value, 'MUST_NOT');
    if (LIKE[f.op]) return constraint(field, LIKE[f.op](value), LIKE[f.op](value), positiva, true);
    if (f.op === 'between') {
      const ate = String(f.valueTo ?? '');
      return constraint(field, value, ate === '' ? value : ate, positiva);
    }
    // Condição desconhecida virando igualdade em silêncio devolveria dado errado sem aviso.
    throw new Error(`Filtro com op "${f.op}" inválido. Use: ${OPERADORES.join(', ')}.`);
  });
}

/** Monta fields/constraints/order do getDataset a partir dos argumentos da ferramenta. */
export function consultaDataset({ fields = [], filters = [], match = 'all', constraints = [], serverLimit, order } = {}) {
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
