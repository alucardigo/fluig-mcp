# fluig-mcp

[![CI](https://github.com/alucardigo/fluig-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alucardigo/fluig-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-informational)](package.json)
[![Ferramentas](https://img.shields.io/badge/ferramentas-97-success)](#as-ferramentas)

Servidor [MCP](https://modelcontextprotocol.io) para o **TOTVS Fluig**. Dá a um agente de IA —
Claude Code, Claude Desktop, Cursor, ou qualquer cliente MCP — acesso às APIs REST e SOAP do
Fluig: datasets, formulários, fichas, GED, eventos, agendador, processos BPM e a ponte para o
TOTVS RM (Corpore).

**97 ferramentas**, homologação e produção no mesmo servidor, sem abrir o Fluig Studio.

```
┌──────────────┐      stdio/MCP      ┌───────────┐   REST v1/v2   ┌──────────────┐
│ Claude Code  │ ◄─────────────────► │ fluig-mcp │ ◄────────────► │ TOTVS Fluig  │
│  (ou outro)  │                     │ 97 tools  │   SOAP/WSDL    │   + RM       │
└──────────────┘                     └───────────┘                └──────────────┘
```

## Por que isto existe

Desenvolver e operar no Fluig normalmente exige o Fluig Studio (Eclipse) na sua máquina e muito
clique no Painel de Controle. Coisas simples — ler o `beforeTaskSave` de um processo, descobrir
por que uma solicitação travou, conferir as linhas de uma tabela pai-filho, publicar uma versão
que ficou em edição — viram sessões inteiras de navegação manual.

Este servidor expõe tudo isso como ferramentas que um agente chama direto. E, mais importante:
ele **embute as armadilhas do produto** que custaram tempo para descobrir (veja
[Armadilhas conhecidas](#armadilhas-conhecidas-do-fluig)), para que você não precise redescobrir
cada uma na marra.

## Instalação

Requer **Node.js 20+**. Sem clonar nada (o `--allow-git=root` é preciso no npm 12, que bloqueia pacotes
vindos do git por padrão; ele libera só este pacote):

```bash
npx -y --allow-git=root github:alucardigo/fluig-mcp --list
```

Ou clonando, para ler o código antes:

```bash
git clone https://github.com/alucardigo/fluig-mcp.git
cd fluig-mcp
npm install
node server.js --list
```

Inspecione o que ele faz **antes** de dar credencial a ele: o `--list` acima já faz isso.

`--list` não carrega configuração nenhuma, de propósito: você consegue auditar a superfície
inteira antes de confiar uma senha ao processo.

## Configuração

Nenhuma variável tem default. Host ou senha embutidos no código seriam um vazamento esperando
acontecer, então variável faltando é **erro explícito**, nunca fallback silencioso para o
servidor de outra pessoa.

| Variável | Ambiente | Obrigatória |
|---|---|---|
| `FLUIG_HOST` · `FLUIG_USER` · `FLUIG_PASS` | homologação (`env: "teste"`) | para usar homologação |
| `FLUIG_HOST_PROD` · `FLUIG_USER_PROD` · `FLUIG_PASS_PROD` | produção (`env: "prod"`) | para usar produção |
| `FLUIG_PASS_CMD` · `FLUIG_PASS_CMD_PROD` | no lugar da senha: comando que a imprime (cofre do sistema) | não |
| `FLUIG_USERCODE` · `FLUIG_USERCODE_PROD` | código do colaborador; sem ele, é descoberto pela sessão | não |
| `FLUIG_SAIDA_DIR` | pasta onde o parâmetro `destino` grava (padrão `~/fluig-mcp-saida`; fora dela é recusado) | não |
| `FLUIG_READONLY=1` | ambos | não — mas leia [Segurança](#segurança) |

Configure um dos pares, ou os dois. Veja [`.env.example`](.env.example) para as opcionais
(tenant, datasources JNDI, IPs semente, prefixo dos datasets descartáveis).

### Senha fora do arquivo de configuração

`FLUIG_PASS_CMD` (e `FLUIG_PASS_CMD_PROD`) recebe um comando cuja saída é a senha. Ele roda sem shell,
só quando o ambiente é usado, e falha **antes** de qualquer login se o comando falhar ou não imprimir
nada. Exemplos:

| Sistema | Guardar uma vez | `FLUIG_PASS_CMD` |
|---|---|---|
| Linux (GNOME Keyring/KWallet) | `secret-tool store --label=fluig service fluig user seu.usuario` | `secret-tool lookup service fluig user seu.usuario` |
| macOS (Keychain) | `security add-generic-password -s fluig -a seu.usuario -w` | `security find-generic-password -s fluig -w` |
| [pass](https://www.passwordstore.org/) | `pass insert fluig` | `pass show fluig` |
| 1Password CLI | (no app) | `op read op://Pessoal/Fluig/password` |

No GitHub Copilot (VS Code) não precisa disso: o próprio VS Code pede a senha e a guarda (abaixo).

Configuração de cada cliente (Claude Code, Codex, GitHub Copilot, Cursor, Claude Desktop):
[docs/clientes.md](docs/clientes.md).

### Registrando no cliente MCP

Claude Code / Claude Desktop (`~/.claude.json` ou `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "fluig": {
      "command": "node",
      "args": ["/caminho/para/fluig-mcp/server.js"],
      "env": {
        "FLUIG_HOST": "http://fluig-homolog.suaempresa.com.br:8080",
        "FLUIG_USER": "seu.usuario",
        "FLUIG_PASS": "sua-senha",
        "FLUIG_HOST_PROD": "https://fluig.suaempresa.com.br:8443",
        "FLUIG_USER_PROD": "seu.usuario",
        "FLUIG_PASS_PROD": "sua-senha-de-producao"
      }
    }
  }
}
```

> Se o seu cliente MCP demora a subir servidores pesados, aumente o timeout de inicialização
> (no Claude Code: `MCP_TIMEOUT`, em milissegundos). O default de 30 s estoura quando vários
> servidores sobem em paralelo — e o sintoma, `connection timed out`, parece bug deste servidor
> sem ser.

## `env` é obrigatório em toda chamada

Não existe ambiente default. Toda ferramenta exige `env: "teste"` ou `env: "prod"`, e omitir ou
errar o valor é recusado **antes de qualquer acesso à rede**.

Isso é deliberado e vem de dor real: com um default silencioso, quem pedia produção lia
homologação e reportava o número errado como se fosse de produção. Forçar a escolha explícita em
toda chamada custa nada e elimina os dois erros — ler o ambiente errado e escrever no ambiente
errado.

## Segurança

Este servidor pode alterar dados de produção. Ele foi construído assumindo isso.

**Modo somente leitura.** `FLUIG_READONLY=1` remove as 37 ferramentas de escrita da listagem e
passa a recusá-las. Recomendado para agente rodando sem supervisão.

```bash
FLUIG_READONLY=1 node server.js --list   # 60 ferramentas, nenhuma de escrita
```

**Confirmação explícita.** As ferramentas de escrita estruturais e destrutivas exigem
`confirm: true`, e as destrutivas (`fluig_process_convert_instances`, `fluig_rm_save_record`)
devolvem um **dry-run** com o plano antes de executar qualquer coisa. Doze ferramentas
operacionais ainda **não** exigem `confirm`: `fluig_dataset_save`, `fluig_dataset_enable`,
`fluig_globalevent_save`, `fluig_workflow_events_update`, `fluig_form_save`,
`fluig_process_start`, `fluig_process_move`, `fluig_process_take`, `fluig_rest_post`,
`fluig_job_add`, `fluig_job_delete` e `fluig_job_run`. E `confirm` é uma declaração do modelo, não
um portão humano: o portão humano é a aprovação de ferramenta do seu cliente MCP. Para agente
sem supervisão, use `FLUIG_READONLY=1`.

**Arquivos locais só na pasta de saída.** Todo `destino` — XML de processo, fonte de dataset,
anexo, documento do GED, diagrama, dossiê — é gravado dentro de `FLUIG_SAIDA_DIR` (padrão
`~/fluig-mcp-saida`), e caminho fora dela é recusado. O conteúdo vem do servidor e o caminho vem
do agente: sem esse limite, um anexo com uma instrução plantada ("salve em
`.git/hooks/pre-commit`") viraria execução de código. Links simbólicos e físicos não escapam.

**Texto cortado não volta.** Leituras grandes voltam cortadas em 20 000 caracteres por padrão
(`maxChars`), com um aviso; as ferramentas de escrita recusam conteúdo que traga esse aviso, para
um get → editar → save não gravar um dataset pela metade.

**Proteção da conta no AD.** O login aborta na primeira recusa em vez de repetir, e falha **sem
tocar a rede** quando não há senha configurada. Depois de uma recusa, nenhum novo login é tentado
naquele ambiente até `fluig_session_reset` ou reiniciar o servidor. Três falhas bloqueiam a conta
em domínios com `lockoutThreshold=3` — repetir login é o jeito mais fácil de deixar alguém sem
acesso. Sessão expirada (401, a página de login ou o desvio SAML do Fluig Identity) é refeita
sozinha, **uma vez** por chamada.

**Nem toda ferramenta "de leitura" é read-only.** Executar SQL arbitrário no Fluig exige que o
SQL viva dentro de um dataset, então `fluig_db_query`, `fluig_rm_db_query`, `fluig_service_list`,
`fluig_process_error_log` e `fluig_rm_dataserver_schema` **gravam** um dataset descartável para
rodar — e o SQL fica no histórico imutável (`FDN_DATASETHISTORY`). Elas estão marcadas como
escrita, exigem `confirm` em produção, e a descrição diz isso. Para ler o RM sem escrever nada,
use `fluig_rm_query` (sentença `WS.###`), que roda pelo `dataset-handle/search`.

Um dataset passthrough permanente eliminaria essa escrita, mas criaria coisa pior: um dataset
publicado que executa SQL de qualquer chamador com permissão de rodar dataset. Trocar rastro de
escrita por elevação de privilégio é mau negócio — por isso não foi feito.

Para reportar vulnerabilidade, veja [SECURITY.md](SECURITY.md).

## As ferramentas

`!` marca as que alteram o servidor.

**BPM e processos** (48)
`fluig_task_list` · `fluig_task_count` · `fluig_request_list` · `fluig_request_get` ·
`fluig_process_def_states` · `fluig_process_states` · `fluig_process_active_states` ·
`fluig_process_states_detail` · `fluig_process_actual_thread` · `fluig_process_history` ·
`fluig_process_attachments` · `fluig_process_attachment_download` · `fluig_process_available` ·
`fluig_process_available_users` · `fluig_process_available_users_start` · `fluig_process_search` ·
`fluig_process_version` · `fluig_process_versions` · `fluig_process_image` ·
`fluig_process_diagram_get` · `fluig_process_export_xml` · `fluig_process_events_xml` ·
`fluig_process_event_get` · `fluig_process_possible_assignees` · `fluig_process_formid` ·
`fluig_process_activities_resume` · `fluig_deadline_calc` · `fluig_workflow_exporter` ·
`fluig_workflow_check` · `fluig_workflow_events_get` · `fluig_deploy_list` ·
**!** `fluig_process_start` · **!** `fluig_process_move` · **!** `fluig_process_move_rest` ·
**!** `fluig_process_take` · **!** `fluig_process_cancel` · **!** `fluig_process_import_xml` ·
**!** `fluig_process_event_set` · **!** `fluig_process_event_set_xml` ·
**!** `fluig_process_version_release` · **!** `fluig_process_version_withdraw` ·
**!** `fluig_process_version_delete` · **!** `fluig_process_diagram_set` ·
**!** `fluig_process_create` · **!** `fluig_process_convert_instances` ·
**!** `fluig_process_error_log` · **!** `fluig_deploy_process` · **!** `fluig_workflow_events_update`

**Formulários e fichas** (14)
`fluig_form_list` · `fluig_form_events` · `fluig_form_files` · `fluig_form_file` ·
`fluig_form_full` · `fluig_form_fields` · `fluig_card_list` · `fluig_card_children_get` ·
`fluig_card_html_url` · `fluig_process_card_get` · `fluig_process_card_value` ·
**!** `fluig_form_save` · **!** `fluig_form_create` · **!** `fluig_card_save`

**Datasets** (12)
`fluig_dataset_list` · `fluig_dataset_get` · `fluig_dataset_run` · `fluig_dataset_structure` ·
`fluig_dataset_admin` · `fluig_dataset_history` · `fluig_dataset_draft_check` ·
**!** `fluig_dataset_save` · **!** `fluig_dataset_delete` · **!** `fluig_dataset_enable` ·
**!** `fluig_dataset_restore` · **!** `fluig_dataset_state_set`

**GED** (4)
`fluig_ged_list` · `fluig_ged_path` · `fluig_ged_download` · **!** `fluig_ged_upload`

**TOTVS RM e integração** (6)
`fluig_rm_query` · **!** `fluig_rm_db_query` · **!** `fluig_rm_db_exec` ·
**!** `fluig_rm_dataserver_schema` · **!** `fluig_rm_save_record` · **!** `fluig_service_list`

**Agendador** (4) · **Eventos globais** (2) · **Diagnóstico** (7)
`fluig_jobs_list` · **!** `fluig_job_add` · **!** `fluig_job_delete` · **!** `fluig_job_run` ·
`fluig_globalevent_list` · **!** `fluig_globalevent_save` · `fluig_ping` · `fluig_version` ·
`fluig_session_reset` · `fluig_user_replacements` · `fluig_rest_get` · **!** `fluig_rest_post` ·
**!** `fluig_db_query`

Descrição completa de cada uma: `node server.js --list`.

## Armadilhas conhecidas do Fluig

Cada item abaixo foi medido contra um servidor real e está embutido no código — a ferramenta
valida, converte ou explica em vez de deixar você tropeçar.

| Armadilha | O que acontece |
|---|---|
| `date-calculator` usa `seconds`, não `duration` | Mandar `duration` devolve `NullPointerException` — parece bug do produto e é parâmetro faltando. A API trabalha em **segundos**, mas o `deadlineTime` do modelo é gravado em **minutos**: trocar um pelo outro erra o prazo por 60×. |
| `childrens` lê, `children` escreve | A rota de leitura das linhas pai-filho é plural; a de escrita é singular. Trocar dá 404. |
| `folders/{id}/documents` devolve grid antigo | A lista vem em `invdata`, não em `items`, e `totalrecords` não é o total. Pasta cheia parece vazia para quem procura `items`. |
| `order` é obrigatório no GED | Sem ele, a rota devolve **500**, não 400. |
| `cardindex/html` não aceita `cardId` | Combinação inválida de parâmetros devolve **500**. Use `documentId`+`documentVersionId` ou `processId`+`processInstanceId`. |
| `tasks/count` sem filtro | Varre a base inteira e passa de 120 s. A ferramenta exige `processId`. |
| `states/activities/resume` falha em alguns processos | `javax.ejb.EJBException` independente dos parâmetros. Bug do produto — caia para `fluig_task_list`/`fluig_request_list`. |
| `dataset-handle/search` nunca devolve 404 | Dataset inexistente responde **200** com `columns`/`values` nulos. "Não existe" se disfarça de "zero linhas". |
| `constraintsField` sem valor inicial | Devolve **500**, não 400. Validado antes de sair da máquina. |
| Booleanos do BPM v2 são string | `?active=1` devolve 400; o enum é `["true","false"]`. |
| `pageSize` muda por rota | 1000 no BPM, **100** em `cards`/`childrens` e no GED. |
| `dataset-history` ignora `fields`/`expand` | Cada item traz o fonte inteiro (~8 KB). O histórico é **imutável pela API**: senha que já esteve num dataset continua legível lá. |
| Falar por IP quebra de dois jeitos | Dispara bloqueio de IPS ("Web Filter Violation") e quebra o TLS/SNI em HTTPS. O cliente sonda IP para saber se há caminho vivo, mas **chama pelo hostname**. |
| `cardData` do move SOAP substitui o registro | Todo campo não enviado **some**. Leia o card antes (`fluig_process_card_get`). |
| `convert_instances` é irreversível | Converter **finaliza** as tarefas pendentes e cria novas no destino. Mapeamento errado = trabalho em curso perdido. Dry-run obrigatório. |
| Anexo: bug de `@QueryParam` duplicado | Na rota plural, `user` e `replacedUser` têm a mesma anotação. A ferramenta usa só a singular. |
| `workflow-exporter` anonimiza por default | `anonymizeForms` é `true` no servidor. A ferramenta **exige** a escolha explícita. |
| `/documents/{id}/stream` mente o Content-Type | A implementação reusa o helper dos thumbnails. Confie no `Content-Disposition`. |
| 2xx sem corpo é normal | `release`, `withdraw`, `delete` devolvem 204; `dataset-history/restore` devolve 201 onde a spec diz 202. Nunca faça `JSON.parse` cego. |

## Desenvolvimento

```bash
npm run check   # checagem de sintaxe
npm test        # testes unitários (node --test)
npm run list    # superfície de ferramentas, sem credencial
```

Contribuições são bem-vindas — veja [CONTRIBUTING.md](CONTRIBUTING.md).

## Créditos

**[Gian (@kyso1)](https://github.com/kyso1)** — [issue #3](https://github.com/alucardigo/fluig-mcp/issues/3),
[PR #4](https://github.com/alucardigo/fluig-mcp/pull/4), [#5](https://github.com/alucardigo/fluig-mcp/pull/5),
[#6](https://github.com/alucardigo/fluig-mcp/pull/6) e [#7](https://github.com/alucardigo/fluig-mcp/pull/7)

Mediu num Fluig 1.7.1 de produção que, quando o código do colaborador é a matrícula e não o login,
`fluig_form_list` voltava vazio **sem erro** — e trouxe a correção, que descobre o código pela
sessão e tirou a senha da URL do `resolveTenant`. Também são dele os filtros no servidor do
`fluig_dataset_run`, a senha vinda de um cofre (`FLUIG_PASS_CMD`), o guia de instalação por
cliente ([docs/clientes.md](docs/clientes.md)) e o limite de saída inline com a **pasta de saída
restrita**. Foi ele quem apontou que o `destino` dos downloads gravava em qualquer caminho — o que
levou a pasta de saída a valer para todo arquivo que este servidor grava. A proposta veio antes
dos PRs, com o plano e as medições, e cada PR chegou pequeno, empilhado e testado.

**[Antonio (@antoniosdn)](https://github.com/antoniosdn)** — [PR #2](https://github.com/alucardigo/fluig-mcp/pull/2)

Achou em produção, num Fluig atrás do Fluig Identity, que a sessão expirada não volta como 401, e
sim como **HTTP 200 com o formulário SAML** — e o servidor passava horas devolvendo a página de SSO
até ser reiniciado. A correção refaz o login uma única vez por chamada, agrupa logins simultâneos
num só e amarra o cache SOAP ao cookie, sem abrir mão da proteção contra bloqueio no AD.

**[Antonio (@antoniosdn)](https://github.com/antoniosdn)** — [PR #1](https://github.com/alucardigo/fluig-mcp/pull/1)

Diagnosticou que o `fetch` do Node deriva o SNI e a verificação do certificado **da URL**, não do
header `Host` — então chamar pelo IP fixado quebrava toda requisição HTTPS. O sintoma parecia
instabilidade de rede, e foi tratado como tal por bastante tempo antes de ele apontar a causa.
A correção foi estendida no merge para o cliente SOAP, onde o mesmo defeito existia.

Do fork dele vieram também três decisões de projeto que este repositório adotou:
**configuração sem defaults** (endpoint ou senha embutidos são vazamento esperando acontecer),
**modo somente leitura** e **`--list` auditável sem credencial** — a ideia de que a superfície de
ferramentas precisa ser inspecionável antes de o servidor receber uma senha, hoje verificada no CI.

## Licença

[MIT](LICENSE).

TOTVS, Fluig e RM/Corpore são marcas da TOTVS S.A. Este projeto é independente e não é afiliado,
patrocinado nem endossado pela TOTVS.
