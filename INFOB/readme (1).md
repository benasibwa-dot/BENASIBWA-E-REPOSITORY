# Reading Room M-Pesa payment functions

Three Supabase Edge Functions implement the pay-to-read flow your HTML page
already calls:

| Function      | Called by                          | Does |
|---------------|-------------------------------------|------|
| `stk-initiate`| Browser ("Send payment request")    | Gets a Daraja OAuth token, sends the STK Push prompt, records a `PENDING` row |
| `stk-callback`| Safaricom's servers (not the browser) | Receives the final result, flips the row to `COMPLETE`/`FAILED` |
| `stk-status`  | Browser (polling every ~4s)         | Reads the row's current status |

## 1. Create the database table

Run once in Supabase SQL Editor (this is the same block already referenced
in your HTML's comments):

```sql
create table if not exists mpesa_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id text unique not null,
  phone_number text not null,
  amount numeric not null,
  plan_id text not null,
  plan_hours numeric not null,
  status text not null default 'PENDING',
  failed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mpesa_payments_invoice_idx on mpesa_payments (invoice_id);
alter table mpesa_payments enable row level security;
create policy "public read by invoice id" on mpesa_payments
  for select using (true);
```

No public insert/update policy is needed — the Edge Functions use the
`service_role` key, which bypasses RLS.

## 2. Get Daraja credentials

From https://developer.safaricom.co.ke :

1. Create an app (or use an existing one) → note the **Consumer Key** and
   **Consumer Secret**.
2. Decide **sandbox** (testing, uses shortcode `174379`) vs **production**
   (real money — requires a registered Paybill/Till and a Go-Live approval
   from Safaricom).
3. For sandbox, the test **Passkey** is published on the Daraja docs page
   for "Lipa Na M-Pesa Online". For production, Safaricom emails you the
   passkey after Go-Live approval.
4. Your **shortcode**: `174379` for sandbox; your real Paybill/Till number
   for production.

This is the step your screenshot's error ("Daraja auth failed HTTP 400")
comes from — it means the Consumer Key/Secret pair (or the environment
they're being used against) is wrong. Common mistakes:
- Sandbox keys used with `DARAJA_ENV=production` (or vice versa)
- Keys copied with a trailing space/newline
- Using a Consumer Key from a *different* Daraja app than the Secret

## 3. Set the secrets

```bash
supabase secrets set \
  DARAJA_ENV=sandbox \
  DARAJA_CONSUMER_KEY=your_consumer_key \
  DARAJA_CONSUMER_SECRET=your_consumer_secret \
  DARAJA_SHORTCODE=174379 \
  DARAJA_PASSKEY=your_passkey \
  DARAJA_CALLBACK_URL=https://<your-project-ref>.functions.supabase.co/stk-callback
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already available to
every Edge Function automatically — you don't need to set those yourself.

Note: Safaricom's callback URL must be **publicly reachable over HTTPS**.
Supabase Edge Function URLs qualify. localhost / ngrok tunnels only work
for local testing and will need updating before going live.

## 4. Deploy

```bash
supabase functions deploy stk-initiate
supabase functions deploy stk-callback --no-verify-jwt
supabase functions deploy stk-status
```

`--no-verify-jwt` on `stk-callback` is important — Safaricom's servers
won't send a Supabase auth token, so that function must accept anonymous
requests. `stk-initiate` and `stk-status` are called from the browser with
the publishable key already, which is fine as-is.

## 5. Test in sandbox

Safaricom's sandbox only accepts specific test MSISDNs
(e.g. `254708374149`) — real Kenyan numbers won't get a real prompt in
sandbox mode. Use the test number, then check:

```bash
supabase functions logs stk-initiate
supabase functions logs stk-callback
```

to see the raw Daraja responses if something fails.

## 6. Go live

Once Safaricom approves your Go-Live application for your Paybill/Till:
switch `DARAJA_ENV=production`, swap in production Consumer Key/Secret/
Passkey/Shortcode, and redeploy. Nothing in the front-end HTML needs to
change.
