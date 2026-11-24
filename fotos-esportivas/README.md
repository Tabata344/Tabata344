# Lance Fotos

App (PWA) de **fotos esportivas** (corrida, ciclismo, triathlon, trail…): o fotógrafo envia as fotos do evento e
o atleta acha e compra as suas. Funciona no navegador do celular, instala na tela inicial e abre offline.

## O que é diferente dos apps que já existem

Hoje os sites de fotos de prova buscam pelo **número de peito** (lido por OCR) ou por **selfie**. Os dois falham
em situações comuns: número dobrado, coberto por casaco ou mochila, foto de costas, de lado ou de longe, e quem
não quer mandar o rosto para um servidor. O Lance ataca esses pontos:

| # | Diferencial | Como funciona |
|---|---|---|
| 1 | **Busca pelo tempo de prova** (sem número, sem rosto) | O atleta informa a hora da largada dele e o tempo líquido. O app calcula quando ele passou por cada ponto de foto e mostra as fotos daquele momento, com nota de confiança. |
| 2 | **Busca pelo arquivo do relógio (GPX)** | Strava, Garmin, Coros, Polar: o GPX diz exatamente quando o atleta passou por cada fotógrafo (±45 s). O arquivo é lido no aparelho e não é enviado. |
| 3 | **Acerto do relógio da câmera** | O fotógrafo fotografa o relógio do app com cada câmera e o app calcula quanto a câmera está adiantada ou atrasada, corrigindo todas as fotos dela. É isso que torna a busca por tempo confiável. |
| 4 | **Triagem automática** | Na hora do envio, o app mede a nitidez de cada foto (variância do Laplaciano), esconde as tremidas e agrupa as rajadas, mostrando só a melhor de cada sequência. O atleta não precisa ver 6 fotos quase iguais. |
| 5 | **Marcação rápida com propagação** | Digita o número e Enter. O número vale para a rajada inteira. Foto sem número legível continua sendo achada pelo tempo. |
| 6 | **Preço com teto** | Cada foto tem um preço, mas o atleta nunca paga mais que o valor do pacote do evento: depois disso, as próximas saem de graça. Não precisa decidir antes entre "avulsa" e "pacote". |
| 7 | **Dividir a foto em grupo** | Se a foto tem mais de um atleta marcado, quem compra pode dividir o valor com os outros (cada um paga a sua parte). |
| 8 | **Privacidade ("não quero aparecer")** | O atleta pede para ocultar seu número: as fotos dele somem da busca dos outros e só aparecem quando ele busca pelo próprio número. |
| 9 | **Card para stories** | A foto comprada vira um card 1080×1920 com evento, distância, tempo e ritmo, pronto para baixar ou compartilhar. |

## Como testar

```bash
cd fotos-esportivas
python3 -m http.server 8000
# abra http://localhost:8000
```

Toque em **Carregar evento de demonstração**: o app gera 72 fotos sintéticas de uma corrida de 10 km, algumas
tremidas, em rajadas e metade sem número marcado.

- **Busca sem número:** a atleta Ana (nº 207) correu de casaco. Busque com largada **07:00:42** e tempo **0:52:10**.
- **Busca por GPX:** no console do navegador, `Demo.gpxAna()` gera o GPX dela (o teste automatizado usa isso).
- **Número:** busque por 131, 150, 188…
- **Fotógrafo:** aba 📸 para criar eventos, acertar o relógio, enviar JPEGs reais (o horário vem do EXIF) e marcar números.

## Estrutura

| Arquivo | Função |
|---|---|
| `index.html` / `styles.css` | Telas (atleta, compradas, fotógrafo), tema claro e escuro |
| `app.js` | Telas, carrinho, preço, card para stories, envio e marcação |
| `analise.js` | Nitidez, rajadas, miniaturas com marca d'água, GPX e busca por tempo |
| `exif.js` | Leitor de EXIF (horário com fração de segundo, câmera e GPS) |
| `db.js` | Armazenamento local (IndexedDB) |
| `demo.js` | Evento de demonstração e GPX de exemplo |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Funcionamento offline e instalação |

## Limitações deste protótipo

- Tudo fica **no aparelho** (IndexedDB): fotógrafo e atleta usam o mesmo navegador. Para uso real, falta a nuvem
  (ex.: Supabase Storage + banco, como no app Validade Certa deste repositório) para o fotógrafo publicar e o atleta acessar.
- O **pagamento é simulado**. Próximo passo: Pix/cartão (Mercado Pago, Stripe ou Pagar.me) com repasse ao fotógrafo.
- "Ocultar meu número" não verifica identidade; em produção, exigir login e o número vinculado à inscrição.
- A marcação dos números é manual. Pode-se somar leitura automática (OCR) como mais uma pista, sem depender só dela.
- Busca pelo tempo assume ritmo constante; o GPX é a opção exata.
