# Ambientes Meta separados

Mantenha produção e teste como instalações independentes. Cada ambiente precisa
de App ID, conta Instagram, callback HTTPS, segredo, arquivo `.env` e diretório
de dados próprios. Antes de iniciar o webhook, valide que nenhum valor é comum.

Produção usa callback HTTPS público. Teste usa outro callback HTTPS público,
nunca um redirecionamento local do webhook de produção. Ambas as rotas deixam
`/webhook` público, mesmo quando `/dashboard` ou `/api/*` usam acesso externo.

```text
production: .env.production, data/production, https://chat.example.com/webhook
test: .env.test, data/test, https://test.chat.example.com/webhook
```

Se o validador indicar colisão, corrija o ambiente nomeado antes de iniciar o
processo. Não reutilize segredo, token, callback, conta ou volume.
