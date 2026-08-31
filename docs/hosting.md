# Escolher hospedagem

Este guia compara opções para uma instância MyChat. Ele não contrata domínio,
VM, backup ou armazenamento, nem escolhe um fornecedor. Essas ações externas
e a homologação em VMs permanecem na Fase 4e.

## Critérios mínimos

Escolha uma VM Ubuntu LTS com endereço IPv4 público, acesso SSH, volume
persistente, ao menos 2 GiB de RAM e espaço para banco, recursos e logs. A
imagem publicada atende AMD64 e ARM64, portanto a arquitetura deve ser
confirmada no plano escolhido antes da contratação. Mantenha backup fora do
volume da VM: um snapshot local não substitui uma cópia em outro serviço.

## Comparação orientativa

Preços e catálogos mudam. A coluna de preço é somente ponto de partida, não
cotação nem recomendação. Fontes oficiais consultadas em **2026-08-25**.

| Opção | Preço e recursos iniciais | Regiões e arquitetura | Armazenamento e backup | Facilidade e ressalvas |
| --- | --- | --- | --- | --- |
| [Hetzner Cloud](https://www.hetzner.com/cloud/) | Compare pelo [calculador oficial](https://www.hetzner.com/cloud/#pricing); selecione RAM e disco suficientes para a carga. | Regiões na Europa, EUA e Singapura; confirme AMD64 ou ARM64 no tipo/região antes de criar. | Volume e snapshots devem ser precificados separadamente quando aplicável; mantenha réplica R2 independente. | Console e firewall simples. Disponibilidade de tipo, região e arquitetura varia, então não trate um plano exibido hoje como garantido. |
| [DigitalOcean Droplets](https://www.digitalocean.com/pricing/droplets) | A tabela oficial lista, por exemplo, 2 GiB/1 vCPU/50 GiB SSD por US$12/mês e 4 GiB/2 vCPU/80 GiB por US$24/mês. | Regiões e tipos são escolhidos no painel; confirme a arquitetura oferecida para a região, pois os planos básicos da tabela não são uma promessa de ARM. | A página informa backups percentuais e snapshots por GiB, custos adicionais ao Droplet; mantenha também uma restauração Litestream testável. | Painel e documentação acessíveis. Cobrança, disponibilidade e recursos de backup podem variar por região e conta. |
| [Oracle Cloud Infrastructure](https://www.oracle.com/cloud/price-list/) | Consulte a lista oficial, inclusive o [Always Free](https://www.oracle.com/cloud/free/), sem presumir capacidade disponível. | O shape Ampere A1 é ARM64; confirme quota, capacidade e região antes de depender dele. | Boot/block volumes e backups têm regras e limites próprios, verifique na [documentação de volumes](https://docs.oracle.com/en-us/iaas/Content/Block/Concepts/overview.htm). | Pode servir ao teste ARM64. Capacidade do free tier, quotas e recuperação de conta são ressalvas práticas, não uma base para produção sem plano pago/alternativo. |

Os três permitem Linux, mas nenhum é obrigatório. Para uma primeira instância,
compare custo mensal completo, região próxima dos operadores, RAM disponível,
disco persistente, política de backup, arquitetura e recuperação de acesso.
Registre a escolha, URL consultada, preço exibido e data no runbook da instância.

## Antes de executar atos externos

Os procedimentos para domínio, HTTPS, R2, réplica Litestream e operação estão
em [operações em português](operations.pt-BR.md) e [operations in English](operations.en.md).
Eles são instruções de preparação: nenhuma conta, DNS, VM, bucket ou certificado
é criado por este repositório nesta fase.
