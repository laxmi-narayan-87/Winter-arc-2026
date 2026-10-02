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

drop policy if exists "users can delete their own state" on public.user_state;
create policy "users can delete their own state" on public.user_state
for delete
to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.user_state from anon;

-- Public day templates are read-only for authenticated users.
create table if not exists public.day_templates (
  day_number integer primary key,
  day_date date not null unique,
  title text not null,
  tasks jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.day_templates enable row level security;

revoke all on table public.day_templates from anon;
revoke all on table public.day_templates from authenticated;
grant select on table public.day_templates to authenticated;

drop policy if exists "authenticated users can read day templates" on public.day_templates;
create policy "authenticated users can read day templates"
on public.day_templates
for select
to authenticated
using (true);

insert into public.day_templates (day_number, day_date, title, tasks)
values (
  1,
  '2026-10-01',
  'Day 1',
  '[{"id":"morning-workout","title":"Morning workout","detail":"10 min"},{"id":"winter-arc-project","title":"Build Winter Arc 2026 project","detail":"Build the tracker/project"},{"id":"cycling","title":"Evening cycling","detail":"8 km"},{"id":"ibm-assessment","title":"IBM coding assessment","detail":"Most Frequent · Median · Count Pairs"},{"id":"leetcode-valid-parentheses","title":"LeetCode — Valid Parentheses","detail":"Solve 1 question"},{"id":"leetcode-container-most-water","title":"LeetCode — Container With Most Water","detail":"Solve 1 question"},{"id":"reading","title":"Self-improvement reading","detail":"10+ pages"}]'::jsonb
)
on conflict (day_number) do update
set day_date = excluded.day_date,
    title = excluded.title,
    tasks = excluded.tasks,
    updated_at = now();

-- Public sharing is opt-in. The snapshot contains only fields the owner explicitly publishes.
create table if not exists public.public_shares (
  user_id uuid primary key references auth.users(id) on delete cascade,
  share_slug text not null unique check (share_slug ~ '^[a-z0-9-]{3,80}$'),
  display_name text not null default 'Winter Arc 2026',
  enabled boolean not null default false,
  settings jsonb not null default '{"progress":true,"streak":true,"daily_tasks":false,"projects":true,"skills":true,"milestones":true,"learning":true,"timeline":true,"fitness":false,"notes":false}'::jsonb,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_public_share_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists public_shares_updated_at on public.public_shares;
create trigger public_shares_updated_at before update on public.public_shares
for each row execute function public.set_public_share_updated_at();

alter table public.public_shares enable row level security;
revoke all on table public.public_shares from anon, authenticated;
grant select, insert, update, delete on table public.public_shares to authenticated;
grant select on table public.public_shares to anon;

drop policy if exists "owners can read their public share" on public.public_shares;
create policy "owners can read their public share" on public.public_shares for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "owners can create their public share" on public.public_shares;
create policy "owners can create their public share" on public.public_shares for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "owners can update their public share" on public.public_shares;
create policy "owners can update their public share" on public.public_shares for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "owners can delete their public share" on public.public_shares;
create policy "owners can delete their public share" on public.public_shares for delete to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "anyone can read enabled public shares" on public.public_shares;
create policy "anyone can read enabled public shares" on public.public_shares for select to anon using (enabled = true);

create or replace view public.winter_arc_public_profiles
with (security_invoker = true)
as select share_slug, display_name, snapshot, updated_at
from public.public_shares where enabled = true;

revoke all on public.winter_arc_public_profiles from anon, authenticated;
grant select on public.winter_arc_public_profiles to anon, authenticated;


-- Normalized private content tables. These replace hard-coded personal content
-- while keeping user_state for preferences, notes, and day completion records.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  status text not null default 'in_progress' check (status in ('idea','in_progress','completed','paused')),
  progress integer not null default 0 check (progress between 0 and 100),
  url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists projects_user_id_idx on public.projects(user_id);

create table if not exists public.skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  level integer not null default 0 check (level between 0 and 100),
  evidence text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,name)
);
create index if not exists skills_user_id_idx on public.skills(user_id);

create table if not exists public.milestones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  complete boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists milestones_user_id_idx on public.milestones(user_id);

create table if not exists public.learning_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  topic text not null check (char_length(topic) between 1 and 120),
  note text not null default '',
  learned_at date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists learning_entries_user_id_idx on public.learning_entries(user_id);

create table if not exists public.timeline_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '',
  entry_date date not null default current_date,
  status text not null default 'current' check (status in ('planned','current','done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists timeline_entries_user_id_date_idx on public.timeline_entries(user_id,entry_date);

create or replace function public.touch_winter_arc_updated_at()
returns trigger language plpgsql set search_path = public
as $$ begin new.updated_at = now(); return new; end; $$;

drop trigger if exists projects_updated_at on public.projects;
create trigger projects_updated_at before update on public.projects for each row execute function public.touch_winter_arc_updated_at();
drop trigger if exists skills_updated_at on public.skills;
create trigger skills_updated_at before update on public.skills for each row execute function public.touch_winter_arc_updated_at();
drop trigger if exists milestones_updated_at on public.milestones;
create trigger milestones_updated_at before update on public.milestones for each row execute function public.touch_winter_arc_updated_at();
drop trigger if exists learning_entries_updated_at on public.learning_entries;
create trigger learning_entries_updated_at before update on public.learning_entries for each row execute function public.touch_winter_arc_updated_at();
drop trigger if exists timeline_entries_updated_at on public.timeline_entries;
create trigger timeline_entries_updated_at before update on public.timeline_entries for each row execute function public.touch_winter_arc_updated_at();

alter table public.projects enable row level security;
alter table public.skills enable row level security;
alter table public.milestones enable row level security;
alter table public.learning_entries enable row level security;
alter table public.timeline_entries enable row level security;

revoke all on table public.projects, public.skills, public.milestones, public.learning_entries, public.timeline_entries from anon, authenticated;
grant select, insert, update, delete on table public.projects, public.skills, public.milestones, public.learning_entries, public.timeline_entries to authenticated;

drop policy if exists "owners select own rows" on public.projects;
create policy "owners select own rows" on public.projects for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "owners insert own rows" on public.projects;
create policy "owners insert own rows" on public.projects for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "owners update own rows" on public.projects;
create policy "owners update own rows" on public.projects for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "owners delete own rows" on public.projects;
create policy "owners delete own rows" on public.projects for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "owners select own rows" on public.skills;
create policy "owners select own rows" on public.skills for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "owners insert own rows" on public.skills;
create policy "owners insert own rows" on public.skills for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "owners update own rows" on public.skills;
create policy "owners update own rows" on public.skills for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "owners delete own rows" on public.skills;
create policy "owners delete own rows" on public.skills for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "owners select own rows" on public.milestones;
create policy "owners select own rows" on public.milestones for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "owners insert own rows" on public.milestones;
create policy "owners insert own rows" on public.milestones for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "owners update own rows" on public.milestones;
create policy "owners update own rows" on public.milestones for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "owners delete own rows" on public.milestones;
create policy "owners delete own rows" on public.milestones for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "owners select own rows" on public.learning_entries;
create policy "owners select own rows" on public.learning_entries for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "owners insert own rows" on public.learning_entries;
create policy "owners insert own rows" on public.learning_entries for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "owners update own rows" on public.learning_entries;
create policy "owners update own rows" on public.learning_entries for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "owners delete own rows" on public.learning_entries;
create policy "owners delete own rows" on public.learning_entries for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "owners select own rows" on public.timeline_entries;
create policy "owners select own rows" on public.timeline_entries for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "owners insert own rows" on public.timeline_entries;
create policy "owners insert own rows" on public.timeline_entries for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "owners update own rows" on public.timeline_entries;
create policy "owners update own rows" on public.timeline_entries for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "owners delete own rows" on public.timeline_entries;
create policy "owners delete own rows" on public.timeline_entries for delete to authenticated using ((select auth.uid()) = user_id);

-- Keep the public profile schema conservative even for manually-created rows.
alter table public.public_shares alter column settings set default '{"progress":true,"streak":true,"daily_tasks":false,"projects":false,"skills":false,"milestones":false,"learning":false,"timeline":false,"fitness":false,"notes":false}'::jsonb;


-- Public projection: anonymous readers can only access intentionally public fields.
create table if not exists public.public_share_profiles (
  share_slug text primary key check (share_slug ~ '^[a-z0-9-]{3,80}$'),
  display_name text not null,
  snapshot jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.public_share_profiles enable row level security;
revoke all on table public.public_share_profiles from anon, authenticated;
grant select on table public.public_share_profiles to anon, authenticated;
drop policy if exists "public can read published profiles" on public.public_share_profiles;
create policy "public can read published profiles"
on public.public_share_profiles for select to anon, authenticated using (true);

revoke all on table public.public_shares from anon;
grant select, insert, update, delete on table public.public_shares to authenticated;

drop view if exists public.winter_arc_public_profiles;
create view public.winter_arc_public_profiles with (security_invoker = true)
as select share_slug,display_name,snapshot,updated_at from public.public_share_profiles;
revoke all on public.winter_arc_public_profiles from anon, authenticated;
grant select on public.winter_arc_public_profiles to anon, authenticated;
