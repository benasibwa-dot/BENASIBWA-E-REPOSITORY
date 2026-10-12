// Supabase Edge Function: intasend-stk-push
// Called by the frontend when the reader picks a plan and enters their
// phone number. Your IntaSend secret key lives ONLY here (as a Supabase
// secret) — never in the browser.
//
// Deploy with:
//   supabase functions deploy intasend-stk-push
// Set secrets with:
//   supabase secrets set \
//     INTASEND_PUBLISHABLE_KEY=ISPubKey_live_xxx \
//     INTASEND_SECRET_KEY=ISSecretKey_live_xxx \
//     INTASEND_TEST=false \
//     SUPABASE_URL=https://kjijqazxxbsmerdwoayf.supabase.co \
//     SUPABASE_SERVICE_ROLE_KEY=xxx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import IntaSendPkg from "npm:intasend-node@3";

const IntaSend = (IntaSendPkg as any).default ?? IntaSendPkg;

const PUBLISHABLE_KEY = Deno.env.get("INTASEND_PUBLISHABLE_KEY")!;
const SECRET_KEY = Deno.env.get("INTASEND_SECRET_KEY")!;
const IS_TEST = (Deno.env.get("INTASEND_TEST") ?? "false") === "true";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function normalizePhone(raw: string): string {
  let p = raw.trim().replace(/\s+/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (p.startsWith("0")) p = "254" + p.slice(1);
  if (p.startsWith("7") || p.startsWith("1")) p = "254" + p;
  return p;
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { phone, amount, planId, planHours } = await req.json();
    if (!phone || !amount || !planId || !planHours) {
      return new Response(JSON.stringify({ error: "Missing phone, amount, planId, or planHours" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const msisdn = normalizePhone(phone);
    if (!/^254(7|1)\d{8}$/.test(msisdn)) {
      return new Response(JSON.stringify({ error: "Invalid phone number" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Our own reference — IntaSend echoes this back on every webhook event,
    // and it's what we use to find the right row when the callback arrives.
    const apiRef = `read-${crypto.randomUUID()}`;

    // Record the pending transaction BEFORE calling IntaSend, so there's no
    // race where a fast webhook arrives before the row exists.
    const { error: dbError } = await supabase.from("stk_transactions").insert({
      api_ref: apiRef,
      phone: msisdn,
      amount,
      plan_id: planId,
      plan_hours: planHours,
      status: "pending",
    });
    if (dbError) throw dbError;

    const intasend = new IntaSend(PUBLISHABLE_KEY, SECRET_KEY, IS_TEST);
    const collection = intasend.collection();

    const resp = await collection.mpesaStkPush({
      first_name: "Reader",
      last_name: "Reader",
      email: "reader@example.com", // IntaSend requires an email field; not shown to the payer
      amount,
      phone_number: msisdn,
      api_ref: apiRef,
      host: Deno.env.get("SUPABASE_URL"),
    });

    // Save the invoice_id IntaSend assigned, for reference/debugging.
    if (resp?.invoice?.invoice_id) {
      await supabase
        .from("stk_transactions")
        .update({ invoice_id: resp.invoice.invoice_id })
        .eq("api_ref", apiRef);
    }

    return new Response(JSON.stringify({ apiRef }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
