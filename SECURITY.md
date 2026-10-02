# Security model

Winter Arc is a static GitHub Pages frontend backed by Supabase Auth + Postgres.

## Public vs private

HTML, CSS, JavaScript and the Supabase publishable key are public. The publishable key is not a database password, but it is safe to expose only when Row Level Security (RLS) and least-privilege grants are correctly configured.

Authenticated Winter Arc state is stored in `public.user_state`, with structured content in `projects`, `skills`, `milestones`, `learning_entries`, and `timeline_entries`. Every private table uses ownership-based RLS (`user_id = auth.uid()`) for select, insert, update, and delete. The anonymous role has no private table privileges.

Never put a Supabase secret/service-role key, database password, JWT signing secret, SMTP password, or other server secret in this repository.

## Local cache

The browser may cache state in localStorage for offline/fallback behavior. When signed in, cloud state is the source of truth. On sign-out, cached user state is cleared to prevent one browser user from inheriting another user's local data.

## Authentication

Supabase Auth handles password storage and authentication. The app does not store plaintext passwords. Use a strong unique password and enable stronger password controls, leaked-password protection where available, and MFA for production.

## Production checklist

1. Run `supabase/schema.sql` in Supabase SQL Editor.
2. Confirm RLS is enabled on `public.user_state`.
3. Confirm anonymous access is revoked.
4. Put only the project URL and publishable key in `supabase-config.js`.
5. Configure Supabase Auth Site URL and redirect URLs for the GitHub Pages origin.
6. Enable leaked-password protection in Supabase Auth.
7. Review Supabase Security Advisor findings.
8. Test that two different accounts cannot read or modify each other's rows.

## Threats considered

- Public source inspection: no server secret is required in the frontend.
- Direct API access: RLS and grants enforce row ownership.
- Cross-account browser reuse: local user state is cleared on sign-out/account switch.
- XSS through account identity: user-controlled values are inserted with `textContent`, not HTML.
- Credential storage: delegated to Supabase Auth.
