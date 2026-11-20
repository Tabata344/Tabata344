-- ============================================================
-- Validade Certa — banco de dados na nuvem (Supabase / PostgreSQL)
--
-- Como usar: no painel do Supabase, abra "SQL Editor", cole este
-- arquivo inteiro e clique em "Run". Pode rodar de novo sem problema.
--
-- Segurança: cada tabela tem RLS (Row Level Security). Um usuário só
-- lê e grava dados das lojas das quais é membro.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- Lojas e membros ----------
create table if not exists public.stores (
  id            uuid primary key default gen_random_uuid(),
  name          text not null default '',
  critical_days int  not null default 7  check (critical_days between 0 and 365),
  warn_days     int  not null default 30 check (warn_days between 1 and 730),
  invite_code   text not null unique default upper(encode(gen_random_bytes(5), 'hex')),
  created_by    uuid not null references auth.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default clock_timestamp()
);

create table if not exists public.store_members (
  store_id   uuid not null references public.stores (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null default 'staff' check (role in ('owner', 'staff')),
  email      text,
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);
create index if not exists store_members_user_idx on public.store_members (user_id);

-- ---------- Dados da loja ----------
create table if not exists public.products (
  store_id      uuid not null references public.stores (id) on delete cascade,
  id            text not null,
  barcode       text,
  name          text not null,
  category      text,
  cost          numeric,
  supplier_code text,
  updated_at    timestamptz not null default clock_timestamp(),
  primary key (store_id, id)
);

create table if not exists public.lots (
  store_id    uuid not null references public.stores (id) on delete cascade,
  id          text not null,
  product_id  text not null,
  lot         text,
  expiry      date not null,
  initial_qty numeric not null default 0,
  location    text,
  supplier    text,
  invoice     text,
  created_at  date,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default clock_timestamp(),
  primary key (store_id, id)
);

-- Movimentações só são acrescentadas (nunca alteradas): a quantidade do
-- lote é initial_qty + entradas − saídas, calculada no aplicativo.
create table if not exists public.movements (
  store_id   uuid not null references public.stores (id) on delete cascade,
  id         text not null,
  lot_id     text,
  product_id text,
  type       text not null check (type in ('venda', 'promocao', 'descarte', 'devolucao', 'ajuste', 'entrada')),
  qty        numeric not null check (qty >= 0),
  unit_cost  numeric,
  date       date not null,
  note       text,
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (store_id, id)
);

create table if not exists public.nfe_imports (
  store_id    uuid not null references public.stores (id) on delete cascade,
  id          text not null,
  key         text,
  number      text,
  supplier    text,
  date        date,
  imported_at date,
  lots        int,
  updated_at  timestamptz not null default clock_timestamp(),
  primary key (store_id, id)
);

-- Índices para a sincronização ("o que mudou desde...")
create index if not exists products_sync_idx    on public.products    (store_id, updated_at);
create index if not exists lots_sync_idx        on public.lots        (store_id, updated_at);
create index if not exists movements_sync_idx   on public.movements   (store_id, updated_at);
create index if not exists nfe_imports_sync_idx on public.nfe_imports (store_id, updated_at);

-- ---------- updated_at automático ----------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['stores', 'products', 'lots', 'movements', 'nfe_imports'] loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before insert or update on public.%I
                    for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ---------- Funções de permissão ----------
create or replace function public.is_member(p_store uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from store_members where store_id = p_store and user_id = auth.uid());
$$;

create or replace function public.is_owner(p_store uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from store_members where store_id = p_store and user_id = auth.uid() and role = 'owner');
$$;

-- Criar loja: quem cria vira dono
create or replace function public.create_store(p_name text) returns public.stores
language plpgsql security definer set search_path = public as $$
declare s stores;
begin
  if auth.uid() is null then raise exception 'Faça login primeiro'; end if;
  insert into stores (name, created_by) values (coalesce(trim(p_name), ''), auth.uid()) returning * into s;
  insert into store_members (store_id, user_id, role, email)
    values (s.id, auth.uid(), 'owner', auth.jwt() ->> 'email');
  return s;
end $$;

-- Entrar em uma loja com o código de convite
create or replace function public.join_store(p_code text) returns public.stores
language plpgsql security definer set search_path = public as $$
declare s stores;
begin
  if auth.uid() is null then raise exception 'Faça login primeiro'; end if;
  select * into s from stores where invite_code = upper(trim(p_code));
  if not found then raise exception 'Código de convite inválido'; end if;
  insert into store_members (store_id, user_id, role, email)
    values (s.id, auth.uid(), 'staff', auth.jwt() ->> 'email')
    on conflict (store_id, user_id) do nothing;
  return s;
end $$;

-- Dono gera um novo código (o antigo deixa de funcionar)
create or replace function public.new_invite_code(p_store uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not is_owner(p_store) then raise exception 'Apenas o dono da loja'; end if;
  c := upper(encode(gen_random_bytes(5), 'hex'));
  update stores set invite_code = c where id = p_store;
  return c;
end $$;

revoke all on function public.create_store(text), public.join_store(text), public.new_invite_code(uuid) from public, anon;
grant execute on function public.create_store(text), public.join_store(text), public.new_invite_code(uuid) to authenticated;

-- ---------- RLS ----------
alter table public.stores        enable row level security;
alter table public.store_members enable row level security;
alter table public.products      enable row level security;
alter table public.lots          enable row level security;
alter table public.movements     enable row level security;
alter table public.nfe_imports   enable row level security;

drop policy if exists stores_select on public.stores;
create policy stores_select on public.stores for select to authenticated using (is_member(id));
drop policy if exists stores_update on public.stores;
create policy stores_update on public.stores for update to authenticated using (is_owner(id)) with check (is_owner(id));

drop policy if exists members_select on public.store_members;
create policy members_select on public.store_members for select to authenticated using (is_member(store_id));
-- Dono remove funcionários; qualquer um pode sair da loja (remover a si mesmo)
drop policy if exists members_delete on public.store_members;
create policy members_delete on public.store_members for delete to authenticated
  using ((is_owner(store_id) and role <> 'owner') or user_id = auth.uid());

do $$
declare t text;
begin
  foreach t in array array['products', 'lots', 'movements', 'nfe_imports'] loop
    execute format('drop policy if exists member_all on public.%I', t);
    execute format('create policy member_all on public.%I for all to authenticated
                    using (is_member(store_id)) with check (is_member(store_id))', t);
  end loop;
end $$;

-- O usuário anônimo (sem login) não acessa nada
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on public.products, public.lots, public.movements, public.nfe_imports to authenticated;
grant select, update on public.stores to authenticated;
grant select, delete on public.store_members to authenticated;
