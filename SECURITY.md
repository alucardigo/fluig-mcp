# Política de Segurança

## Reportar uma vulnerabilidade

Abra um [Security Advisory privado](https://github.com/alucardigo/fluig-mcp/security/advisories/new)
no GitHub. **Não abra issue pública** para falha de segurança.

Inclua: o que acontece, como reproduzir, e o impacto que você enxerga. Respondo em até 7 dias
corridos. Se concordarmos que é vulnerabilidade, publico a correção e credito você no advisory —
a menos que prefira não ser citado.

## Modelo de ameaça

Este servidor é uma ponte entre um agente de IA e um Fluig real. Isso significa que ele pode
**ler dados de negócio e alterar produção**. As decisões abaixo existem por causa disso.

### Credenciais

- **Nenhum default.** Não há host nem senha embutidos no código. Variável faltando é erro
  explícito, nunca fallback silencioso para o servidor de outra pessoa.
- **Credenciais só por ambiente**, nunca commitadas. `.env` e `.env.*` estão no `.gitignore`
  (exceto `.env.example`).
- **A senha de produção não cai na de homologação.** Esse fallback existia e era uma armadilha:
  mandava a credencial de homologação contra produção.
- **O login não repete.** Ao ser recusado, aborta na primeira tentativa; e falha **sem tocar a
  rede** quando não há senha configurada. Depois de uma recusa, nenhum novo login é tentado
  naquele ambiente até `fluig_session_reset` ou reiniciar o servidor — senão cada chamada de
  ferramenta seguinte gastaria uma tentativa. Em domínio com `lockoutThreshold=3`, repetir login é
  o jeito mais fácil de bloquear a conta de alguém.
- **Sessão expirada é refeita uma vez por chamada**, nunca em laço, e logins simultâneos viram um
  só.

Se você registra o servidor no config do cliente MCP com `FLUIG_PASS`, a senha fica em texto plano
nesse arquivo. Prefira `FLUIG_PASS_CMD` / `FLUIG_PASS_CMD_PROD`: a senha vem de um comando do seu
cofre (`secret-tool`, `security`, `pass`, `op`), executado sem shell — veja
[docs/clientes.md](docs/clientes.md).

### Escrita

- Toda ferramenta de escrita declara `confirm`. As estruturais e destrutivas o exigem em qualquer
  ambiente; doze do ciclo de desenvolvimento (lista no README, seção Segurança) o exigem só em
  produção. `confirm` precisa ser booleano: `"false"` em texto é recusado. E `confirm` é uma
  declaração do modelo, não um portão humano: o portão humano é a aprovação de ferramenta do
  cliente MCP.
- As destrutivas (`fluig_process_convert_instances`, `fluig_rm_save_record`, `fluig_globalevent_delete`)
  devolvem **dry-run** com o plano antes de executar: sem `confirm: true`, nada é alterado.
- `FLUIG_READONLY=1` remove as 37 ferramentas de escrita da listagem e passa a recusá-las. Use
  isso para agente sem supervisão.
- `env` é obrigatório em toda chamada. Não existe ambiente default — é o que impede escrever em
  produção achando que é homologação.

### Arquivos locais

Todo `destino` — XML de processo, fonte de dataset, anexo, documento do GED, diagrama, dossiê — é
gravado dentro de `FLUIG_SAIDA_DIR` (padrão `~/fluig-mcp-saida`, pasta 0700, arquivos 0600). O
conteúdo vem do servidor e o caminho vem do agente: sem esse limite, um anexo com uma instrução
plantada poderia ser gravado em `~/.bashrc` ou num hook do git. Caminho fora da pasta é recusado,
links simbólicos e junctions são conferidos pelo caminho real, e a gravação por temporário +
`rename` não segue link físico.

O caminho do arquivo que **sobe** ao Fluig também vem do agente: `caminhoLocal`
(`fluig_ged_upload`), `zipPath` (`fluig_form_create`), `xmlPath` e `svgPath`
(`fluig_deploy_process`). Sem limite, um texto plantado numa ficha ou num anexo poderia induzir o
agente a publicar `~/.ssh/id_rsa` no GED. Esses arquivos só são lidos de dentro da mesma pasta,
conferidos pelo caminho real e abertos sem seguir link. Um link físico dentro da pasta é lido como
qualquer arquivo dela: criar um exige escrita local na pasta.

### Ferramentas de leitura que escrevem

Executar SQL arbitrário no Fluig exige que o SQL viva dentro de um dataset. Por isso
`fluig_db_query`, `fluig_rm_db_query`, `fluig_service_list`, `fluig_process_error_log` e
`fluig_rm_dataserver_schema` gravam um dataset descartável — e o SQL fica em
`FDN_DATASETHISTORY`, que é **imutável pela API**.

Elas são tratadas como escrita: aparecem com `!`, somem no modo somente leitura e exigem
`confirm` em produção.

Um dataset passthrough permanente eliminaria a escrita, mas publicaria um dataset capaz de
executar SQL de **qualquer** chamador com permissão de rodar dataset. Isso troca rastro de
escrita por elevação de privilégio, então não foi feito.

### O que este projeto não protege

- **O histórico de datasets é imutável pela API.** Se uma credencial já esteve escrita dentro de
  um dataset no seu servidor, ela continua legível via `dataset-history` mesmo depois de trocada.
  Trocar a senha não apaga o histórico. Isso é comportamento do Fluig, não deste projeto — mas
  vale auditar, porque é comum encontrar usuário e senha de integração em texto plano ali.
- **`fluig_rest_get` / `fluig_rest_post` são escape hatches.** Eles alcançam qualquer rota da API
  com a sessão autenticada. Se você não quer isso, rode em modo somente leitura (o `_post` some)
  ou não exponha este servidor a um agente sem supervisão.
- **O agente vê o que você deixa ele ver.** Este servidor não filtra dado de negócio. Conteúdo
  lido do Fluig — fichas, anexos, dossiês — chega inteiro ao cliente MCP.

## Escopo

Vale como vulnerabilidade: vazamento de credencial, escrita que escapa do `confirm`/`readOnly`,
injeção que permita executar algo não pretendido, ou qualquer coisa que faça o servidor agir num
ambiente diferente do que o `env` pediu.

Não vale: comportamento do TOTVS Fluig em si (reporte à TOTVS), e configurações inseguras
escolhidas por quem instala — como apontar para produção sem `FLUIG_READONLY` e entregar a um
agente autônomo.
