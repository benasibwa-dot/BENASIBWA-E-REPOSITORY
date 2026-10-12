// Supabase Edge Function: intasend-callback
// IntaSend calls THIS endpoint whenever a transaction's state changes
// (PENDING -> PROCESSING -> COMPLETE or FAILED). You register this
// function's URL in the IntaSend dashboard under Settings -> Webhooks,
// along with a "challenge" string that must match what's set below.
//
// Deploy with:
//   supabase functions deploy intasend-callback --no-verify-jwt
// (--no-verify-jwt is required: IntaSend can't send a Supabase auth
// token, so this function must accept unauthenticated requests. It
// verifies authenticity itself via the "challenge" field instead.)
//
// Set secrets with:
//   supabase secrets set \
//     INTASEND_WEBHOOK_CHALLENGE=<the same phrase you set in the IntaSend dashboard> \
//     SUPABASE_URL=https://kjijqazxxbsmerdwoayf.supabase.co \
//     SUPABASE_SERVICE_ROLE_KEY=xxx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const WEBHOOK_CHALLENGE = Deno.env.get("INTASEND_WEBHOOK_CHALLENGE")!;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  try {
    const body = await req.json();

    if (body.challenge !== WEBHOOK_CHALLENGE) {
      console.warn("Webhook challenge mismatch — ignoring request.");
      return new Response(JSON.stringify({ error: "Invalid challenge" }), { status: 401 });
    }

    const apiRef = body.api_ref;
    const state = body.state; // PENDING | PROCESSING | COMPLETE | FAILED
    if (!apiRef || !state) {
      return new Response(JSON.stringify({ error: "Missing api_ref or state" }), { status: 400 });
    }

    if (state === "PENDING" || state === "PROCESSING") {
      // Nothing to do yet — the frontend is still polling.
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    await supabase
      .from("stk_transactions")
      .update({
        status: state === "COMPLETE" ? "success" : "failed",
        invoice_id: body.invoice_id ?? undefined,
        failed_reason: body.failed_reason ?? null,
      })
      .eq("api_ref", apiRef);

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), { status: 500 });
  }
});
