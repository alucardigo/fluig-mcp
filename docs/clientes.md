# Instalando o fluig-mcp em cada cliente

Todos os exemplos usam produção com a senha vinda de um comando (`FLUIG_PASS_CMD_PROD`, ver o README).
Para homologação, troque os nomes por `FLUIG_HOST`, `FLUIG_USER` e `FLUIG_PASS_CMD`.

Comece com `FLUIG_READONLY=1` e tire quando precisar escrever.

As ferramentas com `destino` (XML de processo, fonte de dataset) gravam em `~/fluig-mcp-saida`; para outra pasta,
acrescente `FLUIG_SAIDA_DIR` ao `env`.

## De onde vem o pacote

Os exemplos usam o pacote do [npm](https://www.npmjs.com/package/fluig-mcp) com a versão fixada:
`npx -y fluig-mcp@1.1.0`. **Fixe sempre a versão**: sem ela, cada subida busca a última publicada, com a
sua senha de produção no ambiente. Para atualizar, troque o número quando decidir (veja as
[releases](https://github.com/alucardigo/fluig-mcp/releases)).

Cada versão sai do CI deste repositório com provenance e só fica pública depois de aprovada com 2FA.
Para conferir de onde veio: `npm view fluig-mcp@1.1.0 dist.attestations`.

Quem prefere instalar direto do GitHub pode trocar `fluig-mcp@1.1.0` por
`--allow-git=root github:alucardigo/fluig-mcp#v1.1.0`. O npm 12 recusa pacote vindo do git por padrão,
e `--allow-git=root` libera o git só para o pacote pedido, não para as dependências dele.

A primeira subida baixa e instala o pacote e pode demorar mais que o tempo de inicialização padrão do
cliente; cada seção abaixo diz como aumentá-lo.

## Claude Code

```bash
claude mcp add fluig --scope user \
  -e FLUIG_HOST_PROD=https://fluig.suaempresa.com.br \
  -e FLUIG_USER_PROD=seu.usuario \
  -e FLUIG_PASS_CMD_PROD="secret-tool lookup service fluig-prod user seu.usuario" \
  -e FLUIG_READONLY=1 \
  -- npx -y fluig-mcp@1.1.0
```

- `--scope user` vale em todos os projetos. Sem ele, o padrão é `local`: só o diretório onde você rodou o
  comando enxerga o servidor. `--scope project` grava em `.mcp.json`, que vai para o repositório; não use
  com host e usuário de produção.
- Tudo depois do `--` é o comando do servidor; as opções do `claude` (`-e`, `--scope`) vêm antes dele.
- Tempo de inicialização: `MCP_TIMEOUT` em milissegundos (`MCP_TIMEOUT=60000 claude`).

## Codex (OpenAI)

Pelo terminal:

```bash
codex mcp add fluig \
  --env FLUIG_HOST_PROD=https://fluig.suaempresa.com.br \
  --env FLUIG_USER_PROD=seu.usuario \
  --env "FLUIG_PASS_CMD_PROD=secret-tool lookup service fluig-prod user seu.usuario" \
  --env FLUIG_READONLY=1 \
  -- npx -y fluig-mcp@1.1.0
```

O `codex mcp add` não define `startup_timeout_sec`, cujo padrão é 10 s: pouco para a primeira subida pelo
npx. Depois do comando, acrescente `startup_timeout_sec = 60` em `[mcp_servers.fluig]` no
`~/.codex/config.toml`, ou escreva a configuração direto nele:

```toml
[mcp_servers.fluig]
command = "npx"
args = ["-y", "fluig-mcp@1.1.0"]
startup_timeout_sec = 60

[mcp_servers.fluig.env]
FLUIG_HOST_PROD = "https://fluig.suaempresa.com.br"
FLUIG_USER_PROD = "seu.usuario"
FLUIG_PASS_CMD_PROD = "secret-tool lookup service fluig-prod user seu.usuario"
FLUIG_READONLY = "1"
```

## GitHub Copilot (VS Code)

`.vscode/mcp.json` no projeto (ou "MCP: Open User Configuration" para valer em todos). O VS Code pede a
senha na primeira vez que o servidor sobe e a guarda no armazenamento seguro dele; ela não fica no arquivo.

```json
{
  "inputs": [
    { "type": "promptString", "id": "fluig-pass", "description": "Senha do Fluig (produção)", "password": true }
  ],
  "servers": {
    "fluig": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "fluig-mcp@1.1.0"],
      "env": {
        "FLUIG_HOST_PROD": "https://fluig.suaempresa.com.br",
        "FLUIG_USER_PROD": "seu.usuario",
        "FLUIG_PASS_PROD": "${input:fluig-pass}",
        "FLUIG_READONLY": "1"
      }
    }
  }
}
```

## Cursor e Claude Desktop

Os dois usam o mesmo formato (`mcpServers`). O arquivo fica em:

| Cliente | Arquivo |
|---|---|
| Cursor | `~/.cursor/mcp.json` (no Windows, `%USERPROFILE%\.cursor\mcp.json`), ou `.cursor/mcp.json` no projeto |
| Claude Desktop | Settings > Developer > Edit Config. macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "fluig": {
      "command": "npx",
      "args": ["-y", "fluig-mcp@1.1.0"],
      "env": {
        "FLUIG_HOST_PROD": "https://fluig.suaempresa.com.br",
        "FLUIG_USER_PROD": "seu.usuario",
        "FLUIG_PASS_CMD_PROD": "security find-generic-password -s fluig-prod -w",
        "FLUIG_READONLY": "1"
      }
    }
  }
}
```

O Claude Desktop só lê o arquivo ao abrir: feche-o por completo e abra de novo.

## Windows

**Senha.** Sem módulo nenhum, o PowerShell guarda a credencial num arquivo cifrado pelo Windows (DPAPI),
que só o seu usuário, nesta máquina, consegue abrir. Guarde uma vez:

```powershell
Get-Credential seu.usuario | Export-Clixml $env:USERPROFILE/.fluig-prod.xml
```

E use como `FLUIG_PASS_CMD_PROD` (no JSON, exatamente assim; o `$env:USERPROFILE` é expandido pelo
PowerShell na hora de ler):

```
powershell.exe -NoProfile -NonInteractive -Command '[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write((Import-Clixml $env:USERPROFILE/.fluig-prod.xml).GetNetworkCredential().Password)'
```

O `[Console]::OutputEncoding` não é enfeite: sem ele, o PowerShell 5.1 escreve no code page do console
(850 no Windows em português) e uma senha com acento ou `ç` chegaria trocada. O fluig-mcp recusa saída
que não é UTF-8 antes de tentar o login, mas é melhor nem chegar lá.

Já usa o módulo `Microsoft.PowerShell.SecretManagement`? Guarde com
`Set-Secret -Name fluig-prod -Secret (Read-Host -AsSecureString)` e troque o miolo do comando por
`[Console]::Out.Write((Get-Secret -Name fluig-prod -AsPlainText))`. Só funciona com um cofre que não pede
senha na hora: o SecretStore, na configuração padrão, pede a senha do cofre, e o cliente MCP não tem onde
digitá-la.

**`.cmd` e `.bat` não rodam.** O `FLUIG_PASS_CMD` roda sem shell, e desde o Node 20.12.2 (CVE-2024-27980)
o Windows recusa `.cmd`/`.bat` assim (erro `EINVAL`); sem shell, o PATH também só acha `.exe` e `.com`
(erro `ENOENT`). CLIs instaladas pelo npm são `.cmd`: aponte para o `.exe` quando houver, ou chame a CLI de
dentro do `powershell.exe -NoProfile -Command`.

**Linha de comando.** Os exemplos em bash quebram linha com `\`; no PowerShell, escreva o `claude mcp add`
ou o `codex mcp add` numa linha só. Se o servidor não conectar com `spawn npx ENOENT`, use `cmd /c npx`
como comando (`-- cmd /c npx -y fluig-mcp@1.1.0`), rodando o comando no
PowerShell e não no Git Bash, que transforma o `/c` em `C:/`.

## Conferindo

Peça ao agente para chamar `fluig_version` com `env: "prod"`: a resposta mostra o host, quem está
autenticado e o código do colaborador em uso (e de onde ele veio).
