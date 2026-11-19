# Validade Certa

App (PWA) de **controle de validade de produtos para comércio**: mercados, padarias, farmácias e distribuidoras.
Funciona no navegador do celular, pode ser instalado na tela inicial e funciona offline.

## Funcionalidades (MVP)

- **Cadastro de lotes** por código de barras: câmera do celular ou leitor USB/Bluetooth.
  - Produto já cadastrado tem nome, categoria e custo preenchidos automaticamente.
  - Mesmo produto + lote + validade + local soma a quantidade.
- **Painel**: contadores de vencidos, críticos (≤ 7 dias), atenção (≤ 30 dias) e em dia, lista de "ação necessária" e **valor em risco** pelo custo.
- **Lotes**: busca por nome, código, lote ou local, com filtros por status e cores.
- **Baixa** de lote: vendido, promoção, descarte (perda), devolução ao fornecedor ou ajuste.
- **Relatórios** por período: valor perdido, valor recuperado em devolução, unidades salvas, taxa de aproveitamento e produtos com mais perda.
- **Alertas**: notificação diária ao abrir o app quando há itens vencidos ou críticos. Os prazos são configuráveis.
- **Backup**: exporta e restaura em JSON e exporta lotes em CSV (abre no Excel).
- **Importar nota fiscal (NF-e XML)** do fornecedor: produtos, quantidade e custo vêm da nota.
  - Lote e validade vêm preenchidos quando a nota traz o grupo `rastro`; senão, basta digitar a data.
  - Converte caixa em unidades (ex.: 2 CX = 24 UN) usando a unidade tributável da nota.
  - Avisa quando a mesma nota é importada duas vezes e guarda o fornecedor e o nº da NF no lote (útil para devolução).
- **Importar planilha** (Excel `.xlsx` ou CSV, inclusive CSV "ANSI" de sistemas antigos):
  - Reconhece as colunas automaticamente (EAN, descrição, grupo, custo, validade, estoque…), com ajuste manual.
  - Aceita datas `31/12/2026`, `31/12/26`, `2026-12-31`, `12/2026` (último dia do mês) e datas do Excel.
  - Se houver validade e quantidade, cria os lotes também.
- Arquivos para testar em `exemplos/` (nota fiscal fictícia e modelo de planilha).
- Dados de exemplo, para demonstração.

## Como rodar

Não precisa de build. Sirva a pasta com qualquer servidor estático:

```bash
python3 -m http.server 8000
# abra http://localhost:8000
```

A câmera e o service worker exigem **HTTPS** (ou `localhost`). Para testar no celular, publique no
GitHub Pages, Netlify ou Vercel, todos gratuitos para sites estáticos.

## Estrutura

| Arquivo | Função |
|---|---|
| `index.html` | Telas (painel, lotes, novo, relatórios, ajustes) |
| `styles.css` | Visual mobile-first, com tema claro e escuro |
| `app.js` | Lógica, armazenamento local, leitor de código, relatórios |
| `importar.js` | Importação de NF-e (XML) e planilhas (CSV/Excel) |
| `exemplos/` | Nota fiscal fictícia e modelo de planilha para testar |
| `sw.js` | Cache offline e clique na notificação |
| `manifest.webmanifest` | Instalação como app |

## Limitações atuais

- Os dados ficam **só no aparelho** (localStorage). Trocar de celular ou limpar o navegador apaga tudo; use o backup.
- Não há login nem sincronização entre vários funcionários.
- Os alertas só disparam ao abrir o app. Push em segundo plano exige servidor.

## Próximos passos sugeridos

1. **Backend + login** (ex.: Supabase/Firebase): vários usuários por loja, sincronização e backup automático.
2. **Push diário** pelo servidor, mesmo com o app fechado.
3. **Leitura da data por foto (OCR)**, para cadastrar mais rápido.
4. **Receber a NF-e automaticamente** (e-mail do fornecedor ou consulta pela chave/CNPJ via serviço de terceiros), sem precisar baixar o XML.
5. **Base de produtos por EAN** (ex.: Cosmos/Open Food Facts), para preencher o nome automaticamente.
6. **Multi-loja**, perfis (gerente/repositor) e relatório mensal em PDF.
7. Monetização: assinatura mensal por loja (plano grátis limitado em nº de lotes).
