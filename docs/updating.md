# Atualização e rollback seguros

Use sempre versão estável e digest `sha256` autenticado. `latest`,
pré-lançamentos e digests ausentes são recusados antes do preflight.

O caminho é: preflight, backup, sincronização Litestream, pull, migração,
reinício e health check. Em falha, restaura backup e volta à versão anterior,
sem substituir `.env` ou o volume de dados.

Terminal exige autenticação local. Painel pede reautenticação e usa o mesmo
planejador, mostrando `running`, `completed`, `reverted` ou `failed`. A consulta
de versão ocorre no máximo uma vez por dia, não envia telemetria e falha aberta.

Execução contra VM, Docker, Litestream e manifesto reais será homologada na
Fase 4e.
