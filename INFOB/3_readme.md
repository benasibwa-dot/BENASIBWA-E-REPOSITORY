# Enabling real M-Pesa STK Push via IntaSend

Since paybill 247247 turned out to be your bank's shared deposit paybill
(not a business paybill registered for Daraja API products), this setup
uses **IntaSend** instead — a Kenyan payment gateway that already has the
Safaricom relationship, so you don't need your own paybill/till at all.
Money still lands in your bank account (0500180043868); IntaSend just
sits in between and takes a small per-transaction fee.

## Files

- `1_supabase_table.sql` — run once in Supabase's SQL editor. If you
  already ran the old Daraja version of this table, run
  `drop table if exists stk_transactions;` first.
- `supabase/functions/intasend-stk-push/index.ts` — triggers the phone prompt.
- `supabase/functions/intasend-callback/index.ts` — receives IntaSend's confirmation.
- `2_frontend_pay_gate_snippet.js` — replaces two functions in your `index.html`.

## Steps

1. **Sign up at IntaSend** (payment.intasend.com) if you haven't, and get
   your Publishable Key + Secret Key from Settings → API Keys.

2. **Run the SQL** in `1_supabase_table.sql` via the Supabase SQL editor.

3. **Deploy the callback function first:**
   ```
   supabase functions deploy intasend-callback --no-verify-jwt
   ```
   Copy the URL it prints.

4. **Set secrets** (fill in your real IntaSend values and a challenge
   phrase you make up yourself):
   ```
   supabase secrets set \
     INTASEND_PUBLISHABLE_KEY=ISPubKey_live_xxx \
     INTASEND_SECRET_KEY=ISSecretKey_live_xxx \
     INTASEND_TEST=false \
     INTASEND_WEBHOOK_CHALLENGE=some-secret-phrase-you-make-up \
     SUPABASE_URL=https://kjijqazxxbsmerdwoayf.supabase.co \
     SUPABASE_SERVICE_ROLE_KEY=xxx
   ```
   Get `SUPABASE_SERVICE_ROLE_KEY` from Supabase dashboard → Project
   Settings → API → `service_role` key (different from the publishable
   key already in your HTML — this one is secret).

5. **Register the webhook in IntaSend's dashboard** (Settings →
   Webhooks): paste the `intasend-callback` URL from step 3 as the
   destination, and enter the exact same phrase you set as
   `INTASEND_WEBHOOK_CHALLENGE` in step 4.

6. **Deploy the push function:**
   ```
   supabase functions deploy intasend-stk-push
   ```
   Copy its URL.

7. **Update `index.html`:** open `2_frontend_pay_gate_snippet.js`, set
   `STK_PUSH_FUNCTION_URL` to the URL from step 6, then:
   - Replace the existing `renderPayStep2()` function with the one here.
   - Add the new `stkPollTimer` / `stopStkPolling` / `triggerStkPush` / `pollStkStatus` functions right after it.
   - Delete the old `tryPayUnlock()` function.

8. **Test with a small real payment** — send yourself KSH 3 (the 1-hour
   plan) and confirm the page unlocks automatically within a few
   seconds of entering your PIN.

## If something doesn't confirm

- Supabase → Edge Functions → `intasend-callback` → Logs shows whether
  IntaSend is reaching your callback at all.
- A `stk_transactions` row stuck on `pending` usually means either the
  webhook URL isn't registered correctly in IntaSend, or the challenge
  phrase doesn't match exactly (case-sensitive) between IntaSend's
  dashboard and your `INTASEND_WEBHOOK_CHALLENGE` secret.
- Errors from `intasend-stk-push` are usually a wrong/missing secret
  key, or `INTASEND_TEST` set to the wrong value for your key type
  (test keys need `INTASEND_TEST=true`, live keys need `false`).
