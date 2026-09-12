# Instalação guiada no Ubuntu LTS

Este guia junta os contratos locais da instalação, sem exigir um provedor
específico. Para a implantação humana validada em uma VPS OVHcloud com
Cloudflare Tunnel, siga também o [guia de configuração da
OVHcloud](ovhcloud-setup.pt-BR.md). Para a condução por agente, use o
[playbook operacional](agent-installation-playbook.md).

A homologação externa começou na Fase 4e. A instalação local continua sendo o
contrato de menor privilégio para desenvolvimento e reprodução de defeitos.

## Antes de começar

Use Ubuntu LTS 22.04 ou 24.04, em `amd64` ou `arm64`. Confirme que você tem
acesso SSH recuperável e espaço para o volume persistente `mychat-data`.

Primeiro, gere o plano sem efeitos colaterais:

```sh
node scripts/install-plan.js arm64
```

O plano não acessa a rede, não coleta segredos e só lista os comandos de
privilégio depois de consentimento explícito. Ele prepara `.env` apenas com a
infraestrutura, inicia `docker compose` e verifica a saúde com `docker compose
ps --status running`. Depois, abra o MyChat: o wizard define senha, idioma e
fuso; em Integrações configure Webhook → Meta → armazenamento. Tokens e
credenciais não pertencem ao `.env` de uma instalação nova.

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
atos externos: mantenha-os separados do ambiente local e registre apenas
evidência redigida.
