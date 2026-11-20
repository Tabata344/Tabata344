// Configuração da nuvem (Supabase).
// Preencha com os dados do seu projeto: Supabase → Project Settings → API.
//  - supabaseUrl: "Project URL" (ex.: https://abcdefgh.supabase.co)
//  - supabaseAnonKey: chave "anon public" (ou "publishable").
// Essas duas informações são PÚBLICAS por natureza (vão para o navegador de
// qualquer usuário); a segurança dos dados vem das regras RLS do banco
// (supabase/schema.sql). NUNCA coloque aqui a chave "service_role"/"secret".
// Deixe em branco para usar o app só no aparelho, sem conta.
window.VALIDADE_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
};
