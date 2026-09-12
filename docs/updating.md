# Atualização e rollback seguros

Use sempre versão estável e digest `sha256` autenticado. `latest`,
pré-lançamentos e digests ausentes são recusados antes do preflight.

O caminho é: preflight, backup, sincronização Litestream, pull, migração,
reinício e health check. Em falha, restaura backup e volta à versão anterior,
sem substituir `.env` ou o volume de dados.

Terminal exige autenticação local. Painel pede reautenticação e usa o mesmo
planejador, mostrando `running`, `completed`, `reverted` ou `failed`. A consulta
de versão ocorre no máximo uma vez por dia, não envia telemetria e falha aberta.

Na VPS de referência, a troca manual de uma tag imutável, seguida de `pull`,
reinício apenas do serviço `app` e checagens local e pública foi validada. O
roteiro detalhado está no [guia da OVHcloud](ovhcloud-setup.pt-BR.md). A
restauração de backup em cópia isolada continua sendo a condição para declarar
o plano de recuperação completo. Essa prova de restauração permanece parte da
homologação externa iniciada na Fase 4e.
