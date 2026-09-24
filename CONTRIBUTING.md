# Contribuindo

Obrigado pelo interesse. Este projeto fala com servidores TOTVS Fluig reais, então algumas
regras existem para que uma contribuição bem-intencionada não vire perda de dado na produção de
alguém.

## Antes de abrir PR

```bash
npm run check   # sintaxe
npm test        # testes unitários
npm run list    # a superfície de ferramentas ainda sobe sem credencial?
```

O CI roda isso no Node 20, 22 e 24, e também verifica duas propriedades que valem como teste:
`--list` funciona **sem nenhuma configuração**, e `FLUIG_READONLY=1` não deixa passar nenhuma
ferramenta de escrita.

## Regras que não são negociáveis

**Nenhum default de host ou credencial.** Nunca acrescente um valor padrão para `FLUIG_HOST`,
`FLUIG_PASS` ou equivalentes. Uma ferramenta que já vem com endpoint embutido é vazamento
esperando acontecer, e senha default nunca é a resposta certa. Variável faltando deve ser erro
explícito.

**`--list` não pode exigir credencial.** É o que permite auditar o que este servidor faz antes
de confiar uma senha a ele. Não mova a carga de configuração para o topo do `server.js`.

**Ferramenta nova que escreve entra em `TOOLS_ESCRITA`.** A lista em `server.js` é curada à mão
de propósito — heurística por nome errava nos dois sentidos. Se a sua ferramenta altera qualquer
coisa no servidor, inclusive gravar um dataset descartável para executar SQL, ela é escrita.
Um modo somente leitura que vaza uma ferramenta de escrita é pior do que não existir.

**Escrita exige `confirm`. Destrutiva exige dry-run.** Se a operação pode perder trabalho de
alguém (converter instâncias, apagar versão, gravar no ERP), ela precisa mostrar o plano antes.

**Não teste em processo com solicitações abertas.** Para ponta a ponta, crie processo descartável
com prefixo `ZZ_TESTE_` e limpe depois.

## Estilo

- ES modules, Node 20+, sem transpilação e sem dependência nova sem motivo forte.
- **Comentário explica o porquê, não o quê.** O valor deste repositório está nas armadilhas
  documentadas: se você descobriu que uma rota devolve 500 onde deveria devolver 400, ou que um
  parâmetro tem nome diferente do que a documentação diz, **escreva isso no código**, junto da
  linha que lida com o problema. Foi assim que a tabela de armadilhas do README nasceu.
- Código de dataset roda em **Rhino (ES5)**: nada de `let`, `const`, arrow function ou template
  string dentro de string de dataset.

## Verifique contra um servidor real

Este projeto trata documentação e spec como hipótese, não como fato — porque elas erraram várias
vezes. Se você está corrigindo o comportamento de uma rota, diga no PR **o que você mediu**:
qual servidor, qual versão do Fluig, qual resposta. "A spec diz" não fecha a questão; "chamei e
voltou isto" fecha.

Se não tiver um ambiente para testar, abra a PR mesmo assim e diga que não foi verificada — é
melhor do que uma afirmação sem respaldo.

## Reportando bugs

Inclua: versão do Fluig, o que você chamou (ferramenta e argumentos, **sem credencial**), o que
esperava e o que veio. Se for erro do servidor, cole o `code`/`message` que a API devolveu.

Falha de segurança **não** vai em issue pública — veja [SECURITY.md](SECURITY.md).
