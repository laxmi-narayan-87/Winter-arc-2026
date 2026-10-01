# Winter Arc 2026

A private-first personal progress dashboard.

## Architecture

- Frontend: static HTML/CSS/JS on GitHub Pages
- Authentication: Supabase Auth
- Database: Supabase Postgres
- Authorization: Postgres Row Level Security (RLS)
- Local cache: browser localStorage

## Supabase setup

1. Create a Supabase project.
2. Open **SQL Editor**.
3. Run `supabase/schema.sql`.
4. Open **Project Settings → API Keys** and copy the **Project URL** and **publishable key**.
5. Put those two values in `supabase-config.js`.

The publishable key is designed for browser use. **Never put a secret/service-role key in the repository.**

6. In Supabase Auth, configure the Site URL and allowed redirect URL for:

`https://laxmi-narayan-87.github.io/Winter-arc-2026/`

7. Open the deployed site and create/sign in to your account.

Existing browser progress is migrated to the signed-in account the first time it connects.

## Security

See `SECURITY.md`.

The database is designed so authenticated users can access only their own rows. RLS is enabled and anonymous table privileges are revoked.