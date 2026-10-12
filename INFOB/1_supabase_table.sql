-- Run this once in your Supabase SQL editor.
-- If you already created the old `stk_transactions` table for the direct-
-- Daraja attempt, drop it first (it's empty/unused, safe to remove):
--   drop table if exists stk_transactions;

create table if not exists stk_transactions (
  id uuid primary key default gen_random_uuid(),
  api_ref text unique not null,        -- our own ID, sent to IntaSend and matched on the webhook
  invoice_id text,                     -- IntaSend's ID for this transaction, filled in after the push succeeds
  phone text not null,
  amount integer not null,
  plan_id text not null,               -- '1h' | '5h' | '24h'
  plan_hours integer not null,
  status text not null default 'pending', -- pending | success | failed
  failed_reason text,
  created_at timestamptz not null default now()
);

alter table stk_transactions enable row level security;

create policy "public insert" on stk_transactions for insert with check (true);
create policy "public read" on stk_transactions for select using (true);
