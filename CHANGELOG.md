# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/);
versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [1.2.0] — não lançada

Os dois pontos que a revisão da 1.1.0 ([issue #3](https://github.com/alucardigo/fluig-mcp/issues/3))
deixou de fora por mudarem o comportamento de ferramentas que já existiam.

### ⚠️ Mudanças de comportamento

- **As doze escritas que rodavam sem `confirm` exigem `confirm: true` em produção**:
  `fluig_dataset_save`, `fluig_dataset_enable`, `fluig_globalevent_save`,
  `fluig_workflow_events_update`, `fluig_form_save`, `fluig_process_start`, `fluig_process_move`,
  `fluig_process_take`, `fluig_rest_post`, `fluig_job_add`, `fluig_job_delete` e `fluig_job_run`.
  Em homologação continuam passando direto. Sem `confirm`, a chamada em `env: "prod"` é recusada
  antes de qualquer requisição. Agora toda ferramenta de escrita declara `confirm` no schema.
- **`confirm` precisa ser booleano**, em toda ferramenta de escrita. Os handlers liam `!!confirm`,
  então a string `"false"` contava como confirmação; `"true"` em texto também passa a ser recusado.
- **O arquivo local que sobe ao Fluig só é lido de dentro da pasta de saída** (`FLUIG_SAIDA_DIR`,
  padrão `~/fluig-mcp-saida`): `caminhoLocal` do `fluig_ged_upload`, `zipPath` do
  `fluig_form_create`, `xmlPath` e `svgPath` do `fluig_deploy_process`. Caminho relativo passa a ser
  relativo a ela. Antes, um texto plantado no Fluig podia induzir o agente a publicar
  `~/.ssh/id_rsa` no GED. Quem subia arquivo de outra pasta copia para lá antes; `xml` inline no
  `fluig_deploy_process` continua valendo.

## [1.1.0] — 2026-10-27

Contribuições da comunidade: a proposta e os PRs de
[Gian (@kyso1)](https://github.com/kyso1) — [issue #3](https://github.com/alucardigo/fluig-mcp/issues/3),
[#4](https://github.com/alucardigo/fluig-mcp/pull/4), [#5](https://github.com/alucardigo/fluig-mcp/pull/5),
[#6](https://github.com/alucardigo/fluig-mcp/pull/6), [#7](https://github.com/alucardigo/fluig-mcp/pull/7) —
e o de [Antonio (@antoniosdn)](https://github.com/antoniosdn) — [#2](https://github.com/alucardigo/fluig-mcp/pull/2).
Validado contra um Fluig 1.7.1 de produção (pelos autores) e um Fluig 1.8 de homologação.

### ⚠️ Mudanças de comportamento

- **Todo `destino` fica preso à pasta de saída** (`FLUIG_SAIDA_DIR`, padrão `~/fluig-mcp-saida`),
  inclusive nos downloads (`fluig_process_attachment_download`, `fluig_ged_download`,
  `fluig_process_diagram_get`, `fluig_workflow_exporter`). Caminho fora dela é recusado, e caminho
  relativo passa a ser relativo a ela, não à pasta do processo. Quem baixava direto no projeto
  aponta `FLUIG_SAIDA_DIR` para uma subpasta dedicada — nunca a raiz do repositório.
- **Leituras grandes voltam cortadas** em 20 000 caracteres (`fluig_dataset_get`,
  `fluig_process_export_xml`, `fluig_process_events_xml`), com aviso. Use `destino` para o texto
  inteiro ou `maxChars` para outro limite.
- `fluig_form_list` vazio devolve `{ total: 0, aviso }` em vez de `[]`.

### Adicionado

- `fluig_dataset_run` filtra **no servidor**: `filters` (`eq`, `ne`, `contains`, `starts`, `ends`,
  `between`), `match: "any"` para OU, `constraints` cruas, `serverLimit` (`sqlLimit`) e `order`
  ([#5](https://github.com/alucardigo/fluig-mcp/pull/5), @kyso1). Condição, `type`, `match` ou
  `serverLimit` inválidos são erro, nunca um filtro diferente em silêncio.
- `FLUIG_PASS_CMD` / `FLUIG_PASS_CMD_PROD`: a senha vem de um comando do cofre, sem shell, e um
  comando que falha para tudo **antes** do login ([#6](https://github.com/alucardigo/fluig-mcp/pull/6), @kyso1).
- [docs/clientes.md](docs/clientes.md): instalação no Claude Code, Codex, GitHub Copilot (VS Code),
  Cursor e Claude Desktop ([#6](https://github.com/alucardigo/fluig-mcp/pull/6), @kyso1).
- `destino` e `maxChars` nas ferramentas que devolvem texto grande
  ([#7](https://github.com/alucardigo/fluig-mcp/pull/7), @kyso1).
- `fluig_version` mostra o `colleagueId` em uso e de onde ele veio.
- Releases: publicar um Release no GitHub anexa o tarball do pacote (com SHA-256), publica
  `@alucardigo/fluig-mcp` no GitHub Packages e, com a publicação no npm ligada, `fluig-mcp` no
  npmjs.com com provenance.

### Corrigido

- **Sessão expirada é refeita sozinha**, uma vez por chamada: 401, página de login e o desvio
  SAML do Fluig Identity, que chega como HTTP 200 ([#2](https://github.com/alucardigo/fluig-mcp/pull/2),
  @antoniosdn). Também o 500 com `UT010031: Login failed` que as rotas antigas
  `/ecm/api/rest/ecm/*` devolvem sem sessão. Downloads binários e `_restRaw` não reportam a
  página de SSO como sucesso.
- **`colleagueId` pela sessão** quando `FLUIG_USERCODE` não está definido: onde o código do
  colaborador é a matrícula, `fluig_form_list` voltava vazio sem erro
  ([#4](https://github.com/alucardigo/fluig-mcp/pull/4), @kyso1).
- **Chamadas simultâneas com `env` diferentes trocavam de servidor no meio**: depois do primeiro
  `await`, uma chamada de homologação podia continuar no cliente de produção.
- `fluig_process_events_xml` corta por evento inteiro, em vez de devolver JSON partido.
- `fluig_globalevent_save` não apaga mais os outros eventos globais quando a leitura da lista
  falha (a rota grava a lista inteira e o código partia de uma lista vazia).
- Upload para o GED e criação de formulário não reportam a página de login/SSO como sucesso.
- `fluig_dataset_run` avisa (`limitadoPeloServidor`) quando o `serverLimit` cortou o resultado.
- CLI (`fluig-cli`): `--env prod`; ajuda e comando desconhecido sem rodar o `FLUIG_PASS_CMD`;
  arquivos gravados na pasta de saída, com nome vindo do servidor sem pasta; `form get` não
  corrompe mais arquivo binário; `dataset run --limit` filtra no servidor.
- A descrição de `env` dizia ao agente que produção era `fluig.exemplo.com.br`.
- `npm run check` cobre todos os arquivos, inclusive a CLI.

### Segurança

- **Depois de uma senha recusada, nenhum novo login** naquele ambiente até `fluig_session_reset`:
  antes, cada chamada de ferramenta seguinte tentava de novo, e três bastavam para bloquear a
  conta no AD.
- `resolveTenant` (`FLUIG_COMPANY=-1`) não manda mais a senha na URL
  ([#4](https://github.com/alucardigo/fluig-mcp/pull/4), @kyso1).
- Pasta de saída sem escape por link simbólico, junction ou **link físico** (gravação por
  temporário + `rename`), pasta 0700 e arquivos 0600. `FLUIG_SAIDA_DIR` aceita `~` e recusa
  caminho relativo; no Windows, nome reservado ou terminado em ponto/espaço é recusado.
- `FLUIG_PASS_CMD` usa só a primeira linha da saída, recusa saída fora de UTF-8 antes do login e
  nunca mostra o stdout no erro.
- Ferramentas de escrita recusam texto que saiu cortado de uma leitura.
- Dependências: `npm audit` zerado (eram 12 vulnerabilidades, 1 crítica e 8 altas).
  `@modelcontextprotocol/sdk` 1.32.1, `undici` 6.29.1 (ainda na linha 6, por causa do Node 20),
  `body-parser` 2.4.0 e `fast-uri` 3.1.9. `soap` 1.14.0, conferido contra um Fluig real: as
  chamadas SOAP de leitura devolvem exatamente o mesmo que na 1.10.
- CI e release: actions fixadas por SHA (`checkout` 7, `setup-node` 7, `gitleaks-action` 3 — a v2
  rodava em Node 20, que saiu dos runners do GitHub), Dependabot semanal com uma semana de espera,
  reporte privado de vulnerabilidade ligado.
- README, SECURITY e CONTRIBUTING não prometem mais `confirm` em toda escrita: 12 ferramentas
  operacionais ainda não o exigem, e a lista está no README.

## [1.0.0] — 2026-09-24

Primeira versão pública. 97 ferramentas, dois ambientes, e as armadilhas do produto embutidas
no código.

### Adicionado

- **33 ferramentas novas** cobrindo o que faltava para fechar ciclos que o servidor já abria:
  - *Runtime BPM*: `fluig_task_list`, `fluig_task_count`, `fluig_request_list`,
    `fluig_request_get`, `fluig_process_possible_assignees`, `fluig_process_activities_resume`.
  - *Formulários*: `fluig_card_list`, `fluig_card_children_get` (linhas pai-filho **com
    `rowId`**), `fluig_form_fields`, `fluig_card_save`, `fluig_form_create`,
    `fluig_card_html_url`.
  - *Dataset reversível*: `fluig_dataset_history`, `fluig_dataset_draft_check`,
    `fluig_dataset_restore`, `fluig_dataset_state_set`.
  - *Processo*: `fluig_process_version_release` (publica a versão que `import_xml` deixa em
    edição), `fluig_process_def_states`, `fluig_process_diagram_get`, `fluig_process_move_rest`,
    `fluig_process_create`, `fluig_process_convert_instances`, `fluig_process_error_log`,
    `fluig_workflow_exporter`, `fluig_deadline_calc`.
  - *GED*: `fluig_ged_list`, `fluig_ged_path`, `fluig_ged_download`, `fluig_ged_upload`,
    `fluig_process_attachment_download`.
  - *RM e integração*: `fluig_service_list`, `fluig_rm_dataserver_schema`,
    `fluig_rm_save_record` (escrita no ERP pela business layer, em vez de SQL cru).
  - *Diagnóstico*: `fluig_version`, `fluig_session_reset`.
- **Dois ambientes no mesmo servidor**, com `env` obrigatório em toda chamada.
- **`FLUIG_READONLY=1`**: expõe somente as 60 ferramentas que não alteram o servidor.
- **`--list`, `--help`, `--version`** funcionando sem credencial.

### Corrigido

- `fluig_rm_query` **parou de gravar no servidor**. Era anunciada como read-only e gravava um
  dataset a cada chamada; agora chama `ds_generic_rm_sql` direto pelo `dataset-handle/search`.
- `date-calculator` usa `seconds`, não `duration` — com o nome errado o servidor devolvia
  `NullPointerException`, que parecia bug do produto.
- `fluig_card_html_url` não aceita `cardId`; os parâmetros corretos são
  `documentId`+`documentVersionId` ou `processId`+`processInstanceId`.
- `fluig_ged_list` normaliza o grid antigo (`invdata`), que fazia pasta cheia parecer vazia.
- Requisições saem pelo **hostname**, não pelo IP sondado — corrige o mismatch de TLS/SNI em
  HTTPS e o bloqueio de IPS por acesso via IP. O `fetch` do Node deriva o SNI e a verificação do
  certificado da URL, não do header `Host`, então o IP na URL quebrava toda chamada HTTPS.
  Correção de [Antonio (@antoniosdn)](https://github.com/antoniosdn),
  [PR #1](https://github.com/alucardigo/fluig-mcp/pull/1).
- O mesmo defeito existia no **cliente SOAP**, que montava a URL do WSDL pelo IP — afetando
  `listDatasets`, `runDataset`, `startProcess`, `move` e todas as demais ferramentas SOAP.
  Corrigido junto, no merge do PR #1. Validado em produção HTTPS (627 datasets pelo hostname).
- `fluig_task_count` exige `processId`: sem filtro a rota varre a base e passa de 120 s.

### Segurança

- **Sem defaults de host e credencial.** Variável faltando é erro explícito.
- **A senha de produção não cai mais na de homologação** — o fallback queimava tentativas do
  Active Directory e chegou a bloquear a conta do usuário.
- **O login não repete** ao ser recusado, e falha sem tocar a rede quando não há senha.
- Ferramentas cuja consulta é read-only mas que **gravam um dataset para executar SQL**
  (`fluig_db_query`, `fluig_rm_db_query`, `fluig_service_list`, `fluig_process_error_log`,
  `fluig_rm_dataserver_schema`) passaram a ser tratadas como escrita e exigem `confirm` em
  produção. As descrições pararam de chamá-las de read-only.
- `.gitignore` bloqueia `out/`, dumps e material de análise — são dados do cliente e código
  proprietário de terceiro.

[1.2.0]: https://github.com/alucardigo/fluig-mcp/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/alucardigo/fluig-mcp/compare/e48538a...v1.1.0
[1.0.0]: https://github.com/alucardigo/fluig-mcp/commit/e48538a
