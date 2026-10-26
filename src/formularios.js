/**
 * Resumo da lista de formulários. Lista vazia vinda do servidor quase nunca quer dizer "não há
 * formulários": getCardIndexesWithoutApprover filtra por colleagueId e devolve vazio sem erro quando o
 * código do colaborador está errado (ver FluigClient._descobrirUserCode). Por isso vira aviso.
 */
export function resumoFormularios(forms, filtro, colleagueId, variavel = 'FLUIG_USERCODE') {
  if (!forms.length) {
    return {
      total: 0,
      aviso: `O Fluig devolveu 0 formulários para o colaborador "${colleagueId}". Se há formulários no `
        + `servidor, confira ${variavel} (código do colaborador, que pode ser diferente do login) e as `
        + 'permissões do usuário.',
      formularios: [],
    };
  }
  const f = (filtro || '').toLowerCase();
  return forms
    .filter(x => !f || `${x.documentId} ${x.documentDescription || ''} ${x.datasetName || ''}`.toLowerCase().includes(f))
    .map(x => ({ documentId: x.documentId, version: x.version, description: x.documentDescription, dataset: x.datasetName }));
}
