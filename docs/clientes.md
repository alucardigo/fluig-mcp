# Instalando o fluig-mcp em cada cliente

Todos os exemplos usam produção com a senha vinda de um comando (`FLUIG_PASS_CMD_PROD`, ver o README).
Para homologação, troque os nomes por `FLUIG_HOST`, `FLUIG_USER` e `FLUIG_PASS_CMD`. Enquanto o pacote
não está no npm, o comando é `npx -y --allow-git=root github:alucardigo/fluig-mcp` (o npm 12 bloqueia
pacotes vindos do git por padrão; `--allow-git=root` libera só este, não as dependências).

Comece com `FLUIG_READONLY=1` e tire quando precisar escrever.

## Claude Code

```bash
claude mcp add fluig \
  -e FLUIG_HOST_PROD=https://fluig.suaempresa.com.br \
  -e FLUIG_USER_PROD=seu.usuario \
  -e FLUIG_PASS_CMD_PROD="secret-tool lookup service fluig user seu.usuario" \
  -e FLUIG_READONLY=1 \
  -- npx -y --allow-git=root github:alucardigo/fluig-mcp
```

## Codex (OpenAI)

Pelo terminal:

```bash
codex mcp add fluig \
  --env FLUIG_HOST_PROD=https://fluig.suaempresa.com.br \
  --env FLUIG_USER_PROD=seu.usuario \
  --env "FLUIG_PASS_CMD_PROD=secret-tool lookup service fluig user seu.usuario" \
  --env FLUIG_READONLY=1 \
  -- npx -y --allow-git=root github:alucardigo/fluig-mcp
```

Ou direto em `~/.codex/config.toml`:

```toml
[mcp_servers.fluig]
command = "npx"
args = ["-y", "--allow-git=root", "github:alucardigo/fluig-mcp"]
startup_timeout_sec = 60

[mcp_servers.fluig.env]
FLUIG_HOST_PROD = "https://fluig.suaempresa.com.br"
FLUIG_USER_PROD = "seu.usuario"
FLUIG_PASS_CMD_PROD = "secret-tool lookup service fluig user seu.usuario"
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
      "args": ["-y", "--allow-git=root", "github:alucardigo/fluig-mcp"],
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

`~/.cursor/mcp.json` ou `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "fluig": {
      "command": "npx",
      "args": ["-y", "--allow-git=root", "github:alucardigo/fluig-mcp"],
      "env": {
        "FLUIG_HOST_PROD": "https://fluig.suaempresa.com.br",
        "FLUIG_USER_PROD": "seu.usuario",
        "FLUIG_PASS_CMD_PROD": "security find-generic-password -s fluig -w",
        "FLUIG_READONLY": "1"
      }
    }
  }
}
```

## Conferindo

Peça ao agente para chamar `fluig_version` com `env: "prod"`: a resposta mostra o host, quem está
autenticado e o código do colaborador em uso (e de onde ele veio).
