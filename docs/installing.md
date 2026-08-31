# Instalação guiada no Ubuntu LTS

Este guia junta os contratos locais da instalação, sem executar comandos na VM
nem exigir conta Meta, domínio ou provedor. A homologação externa fica na Fase
4e.

## Antes de começar

Use Ubuntu LTS 22.04 ou 24.04, em `amd64` ou `arm64`. Confirme que você tem
acesso SSH recuperável e espaço para o volume persistente `mychat-data`.

Primeiro, gere o plano sem efeitos colaterais:

```sh
node scripts/install-plan.js arm64
```

O plano não acessa a rede, não coleta segredos e só lista os comandos de
privilégio depois de consentimento explícito. Ele prepara `.env`, gera
`META_APP_SECRET` e `WEBHOOK_VERIFY_TOKEN` no operador, inicia `docker compose`
e verifica a saúde com `docker compose ps --status running`.

## Reexecução segura

Uma nova execução preserva `.env`, os segredos existentes e o volume
`mychat-data`. Para substituir um segredo já existente, faça backup do `.env`
e confirme a troca de forma explícita. Sem essa confirmação, o instalador para
em `secret-confirmation` e informa como retomar.

Falhas têm três elementos: o teste que falhou, a correção sugerida e o ponto de
retomada. Por exemplo, uma permissão negada no socket Docker pede adicionar o
operador ao grupo `docker`, entrar novamente e retomar nos pré-requisitos. Após
uma falha de início da composição, corrija o diagnóstico e retome em
`compose-start`, sem recriar o volume.

## Primeiro uso e operação

Depois da saúde local, siga [o guia de primeiro uso](first-use.md). Sem Meta,
uma automação é somente um rascunho local, nunca prova de entrega.

Para infraestrutura, backup, restauração, atualização, rollback e diagnóstico,
use os runbooks [em português](operations.pt-BR.md) ou
[em inglês](operations.en.md). A escolha de hospedagem é comparada em
[hosting.md](hosting.md); nenhum provedor é obrigatório.

Não exponha o processo diretamente nem aplique autenticação ao `/webhook`.
Domínio, HTTPS público, R2/Litestream e a prova com uma segunda conta Meta são
atos externos, deliberadamente reservados para a Fase 4e.
