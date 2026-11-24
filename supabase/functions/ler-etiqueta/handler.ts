// Lê validade e lote de uma foto da embalagem usando o Claude (IA da Anthropic).
//
// Fluxo: app envia a foto (já reduzida) -> esta função confere login, loja e
// limite diário no banco -> manda a foto ao Claude pedindo um JSON fixo ->
// valida o resultado -> registra modelo e tokens (para medir custo) -> devolve.
//
// Login: conferido pelo banco (RPC consume_label_read roda como o usuário do token).
// Publicada com verify_jwt = false porque o projeto usa chaves de login ES256.
//
// Segredos/variáveis (painel do Supabase > Edge Functions > Secrets):
//   ANTHROPIC_API_KEY  (obrigatório; nunca vai para o app)
//   LABEL_MODEL        (opcional; padrão claude-opus-5-5)
//   LABEL_EFFORT       (opcional; padrão low — extração simples)
import Anthropic from "npm:@anthropic-ai/sdk@1.6.0";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

export const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_IMAGE_B64 = 2_800_000; // ~2 MB de imagem
const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const SYSTEM_PROMPT = `Você lê fotos de embalagens de produtos vendidos no Brasil e extrai a data de VALIDADE e o LOTE impressos.

Como reconhecer:
- Validade: VAL, VALIDADE, V, VENC, VENCIMENTO, CONSUMIR ATÉ, CONSUMIR PREFERENCIALMENTE ANTES DE, BEST BEFORE, EXP.
- Fabricação: FAB, F, FABRICAÇÃO, P, PROD. Não confunda fabricação com validade.
- Lote: L, LOTE, LOT. Copie exatamente os caracteres do lote (letras, números, dois-pontos, espaços), sem o prefixo "L"/"LOTE".
- Código de barras: se aparecer, copie os dígitos impressos logo abaixo das barras (EAN/GTIN, 8 a 14 dígitos), sem espaços.
- Nome do produto: se aparecer, escreva como na embalagem (produto, marca e tamanho, ex.: "Chocolate ao leite Lacta 80g").

Datas no padrão brasileiro (dia antes do mês): 171226 (DDMMAA), 17/12/26, 17.12.2026, 17 DEZ 26, DEZ/26, 12/26 (mês/ano).
Meses abreviados: JAN FEV MAR ABR MAI JUN JUL AGO SET OUT NOV DEZ.
- Se houver só mês e ano, use o último dia do mês e marque month_year_only = true.
- Se houver datas sem rótulo, a mais tardia costuma ser a validade e a mais antiga a fabricação.

A impressão costuma ser de pontinhos (jato de tinta), às vezes falhada, torta ou com reflexo.
NÃO invente: se não tiver segurança sobre um campo, deixe-o vazio e use confidence "low".
readable = false quando a foto não mostra uma validade legível.
note: uma frase curta em português para o funcionário quando houver algo a conferir (ex.: "Reflexo no ano, confira."), ou vazio.`;

export const LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    readable: { type: "boolean", description: "A validade está legível na foto?" },
    expiry_text: { type: "string", description: "Validade exatamente como impressa (ex.: 'VAL:171226'), ou vazio" },
    expiry: { type: "string", description: "Validade no formato AAAA-MM-DD, ou vazio" },
    month_year_only: { type: "boolean", description: "A embalagem mostra só mês e ano?" },
    lot: { type: "string", description: "Lote sem o prefixo L/LOTE, ou vazio" },
    manufactured: { type: "string", description: "Fabricação AAAA-MM-DD se impressa, ou vazio" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    note: { type: "string", description: "Aviso curto em português para o funcionário, ou vazio" },
    barcode: { type: "string", description: "Dígitos impressos abaixo do código de barras, ou vazio" },
    product_name: { type: "string", description: "Nome do produto visível na embalagem, ou vazio" },
  },
  required: ["readable", "expiry_text", "expiry", "month_year_only", "lot", "manufactured", "confidence", "note", "barcode", "product_name"],
} as const;

export interface LabelResult {
  readable: boolean;
  expiry: string;
  expiry_text: string;
  month_year_only: boolean;
  lot: string;
  confidence: "high" | "medium" | "low";
  note: string;
  barcode: string;
  product_name: string;
}

/** Confere o dígito verificador do EAN/GTIN (evita número lido errado). */
export function gtinValid(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const d = code.split("").map(Number);
  const check = d.pop()!;
  const sum = d.reverse().reduce((acc, n, i) => acc + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function validIso(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Confere e limpa o JSON devolvido pela IA. Nunca confia cegamente na resposta. */
export function normalizeResult(raw: unknown, today: string): LabelResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, max = 60) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  let confidence = (["high", "medium", "low"].includes(r.confidence as string) ? r.confidence : "low") as LabelResult["confidence"];
  let note = str(r.note, 160);
  let expiry = str(r.expiry, 10);
  const monthYear = r.month_year_only === true;

  if (expiry && validIso(expiry) && monthYear) {
    // só mês/ano: garante o último dia do mês
    const [y, m] = expiry.split("-").map(Number);
    expiry = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  if (expiry && !validIso(expiry)) { expiry = ""; confidence = "low"; }
  if (expiry) {
    const year = +expiry.slice(0, 4);
    const now = +today.slice(0, 4);
    if (year < now - 5 || year > now + 15) {
      expiry = "";
      confidence = "low";
      note = note || "Não consegui ter certeza do ano. Confira a data.";
    }
  }
  // tira só o prefixo explícito ("LOTE 99", "L: JC10"); "LT9" e "L2311A" ficam como estão
  const lot = str(r.lot, 40).replace(/^(lote|lot)\b\s*[:.\-]?\s*|^l\s*[:.\-]\s*/i, "").trim();
  const digits = str(r.barcode, 20).replace(/\D/g, "");
  return {
    readable: r.readable === true && !!expiry,
    expiry,
    expiry_text: str(r.expiry_text, 60),
    month_year_only: monthYear && !!expiry,
    lot,
    confidence,
    note,
    barcode: gtinValid(digits) ? digits : "",
    product_name: str(r.product_name, 80),
  };
}

function todayInBrazil(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Método não permitido." });

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json(401, { error: "Faça login para usar a leitura por foto." });

  let body: { image?: unknown; media_type?: unknown; store_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Requisição inválida." });
  }
  const image = typeof body.image === "string" ? body.image : "";
  const mediaType = typeof body.media_type === "string" ? body.media_type : "";
  const storeId = typeof body.store_id === "string" ? body.store_id : "";
  if (!UUID_RE.test(storeId)) return json(400, { error: "Loja inválida." });
  if (!MEDIA_TYPES.has(mediaType)) return json(400, { error: "Formato de imagem não suportado." });
  if (!image || image.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
    return json(400, { error: "Imagem inválida ou grande demais." });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json(503, { error: "A leitura por foto ainda não foi ativada (falta a chave da IA)." });

  // Cliente do Supabase com o login de quem chamou: as regras do banco valem para ele
  const supabaseKey = req.headers.get("apikey") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", supabaseKey, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: readId, error: quotaError } = await sb.rpc("consume_label_read", { p_store: storeId });
  if (quotaError) {
    const msg = quotaError.message || "Sem permissão.";
    // sem login válido o banco nem deixa chamar a função (permission denied / JWT)
    if (/permission denied|jwt|login/i.test(msg)) return json(401, { error: "Faça login para usar a leitura por foto." });
    return json(/limite/i.test(msg) ? 429 : 403, { error: msg });
  }

  const model = Deno.env.get("LABEL_MODEL") || DEFAULT_MODEL;
  const effortEnv = Deno.env.get("LABEL_EFFORT") || "low";
  const effort = (EFFORTS.has(effortEnv) ? effortEnv : "low") as "low" | "medium" | "high" | "xhigh" | "max";
  const today = todayInBrazil();
  const client = new Anthropic({ apiKey, baseURL: Deno.env.get("ANTHROPIC_BASE_URL") || undefined });

  const finish = (ok: boolean, m: string | null, input: number | null, output: number | null) =>
    sb.rpc("finish_label_read", { p_id: readId, p_model: m, p_input: input, p_output: output, p_ok: ok });

  try {
    // Fallback no servidor se o modelo recusar (não existe para o Haiku)
    const fallback = model.startsWith("claude-haiku")
      ? {}
      : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };
    const message = await client.beta.messages.create({
      model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      output_config: { effort, format: { type: "json_schema", schema: LABEL_SCHEMA } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg", data: image } },
          { type: "text", text: `Hoje é ${today.split("-").reverse().join("/")}. Leia a validade e o lote desta embalagem.` },
        ],
      }],
      ...fallback,
    });

    const usage = message.usage;
    if (message.stop_reason === "refusal") {
      await finish(false, message.model, usage.input_tokens, usage.output_tokens);
      return json(422, { error: "A IA não conseguiu analisar esta foto. Digite a validade." });
    }
    const text = message.content.find((b) => b.type === "text");
    let parsed: unknown = null;
    try {
      parsed = text && text.type === "text" ? JSON.parse(text.text) : null;
    } catch {
      parsed = null;
    }
    const result = normalizeResult(parsed, today);
    await finish(result.readable, message.model, usage.input_tokens, usage.output_tokens);
    return json(200, { ...result, model: message.model });
  } catch (err) {
    await finish(false, model, null, null);
    if (err instanceof Anthropic.AuthenticationError) {
      return json(503, { error: "A chave da IA é inválida. Avise o responsável pelo app." });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return json(429, { error: "A IA está ocupada. Tente de novo em instantes." });
    }
    if (err instanceof Anthropic.APIError) {
      console.error("Anthropic API error", err.status, err.message);
      return json(502, { error: "Não foi possível ler a foto agora. Tente de novo ou digite a validade." });
    }
    console.error(err);
    return json(500, { error: "Erro inesperado ao ler a foto." });
  }
}
