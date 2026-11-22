// Função do Supabase (Edge Function) "ler-etiqueta". A lógica está em handler.ts.
import { handle } from "./handler.ts";

Deno.serve(handle);
