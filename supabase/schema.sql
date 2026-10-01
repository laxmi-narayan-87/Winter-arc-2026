-- Winter Arc 2026 private data schema
-- Apply through Supabase migrations.

create table if not exists public.user_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  state_key text not null check (char_length(state_key) between 1 and 120),
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, state_key)
);

create or replace function public.set_user_state_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_state_updated_at on public.user_state;
create trigger user_state_updated_at
before update on public.user_state
for each row execute function public.set_user_state_updated_at();

alter table public.user_state enable row level security;

revoke all on table public.user_state from anon;
revoke all on table public.user_state from authenticated;

grant select, insert, update, delete on table public.user_state to authenticated;

drop policy if exists "users can read their own state" on public.user_state;
create policy "users can read their own state"
on public.user_state
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "users can insert their own state" on public.user_state;
create policy "users can insert their own state"
on public.user_state
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "users can update their own state" on public.user_state;
create policy "users can update their own state"
on public.user_state
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "users can delete their own state" on public.user_state
for delete
to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.user_state from anon;
