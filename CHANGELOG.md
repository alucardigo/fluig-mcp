# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/);
versionamento [SemVer](https://semver.org/lang/pt-BR/).

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
  HTTPS e o bloqueio de IPS por acesso via IP.
  (Correção trazida do fork de [Antonio](https://github.com/antoniosdn/fluig-mcp), commit `95a32af`.)
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
