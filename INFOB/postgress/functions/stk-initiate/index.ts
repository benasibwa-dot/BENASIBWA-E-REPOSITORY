// stk-initiate/index.ts
// Called by the front end's "Send payment request" button.
// Body: { phone_number: string, plan_id: "1h" | "5h" | "24h" }
// Returns: { invoice_id: string } on success, or { error: string } (non-2xx) on failure.
//
// invoice_id === Daraja's CheckoutRequestID, which is also what stk-callback
// uses to find and update the row, and what stk-status uses to look it up.
//
// CHANGES from your version:
//   - The phone number is validated/normalized with normalizeKenyanPhone()
//     BEFORE calling Daraja, so a bad number now returns 400 (client error)
//     instead of 502 (which previously lumped it in with real upstream/
//     Daraja failures). The already-normalized number is passed on to
//     initiateStkPush so it isn't reformatted twice.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getDarajaToken,
  initiateStkPush,
  loadDarajaConfig,
  normalizeKenyanPhone,
} from "../_shared/daraja.ts";

const PLANS: Record<string, { hours: number; price: number; label: string }> = {
  "1h": { hours: 1, price: 3, label: "1 hour" },
  "5h": { hours: 5, price: 10, label: "5 hours" },
  "24h": { hours: 24, price: 20, label: "24 hours" },
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { phone_number?: string; plan_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const rawPhone = (body.phone_number || "").trim();
  const plan = body.plan_id ? PLANS[body.plan_id] : undefined;
  if (!rawPhone) return json({ error: "phone_number is required" }, 400);
  if (!plan) return json({ error: "plan_id must be one of 1h, 5h, 24h" }, 400);

  // --- Validate the phone number BEFORE touching Daraja, so a typo'd
  // number gets a clean 400 instead of surfacing as a 502 "upstream
  // failure" once it fails deep inside initiateStkPush. ---
  let phoneNumber: string;
  try {
    phoneNumber = normalizeKenyanPhone(rawPhone);
  } catch {
    return json({ error: "Enter a valid M-Pesa number, e.g. 0712345678." }, 400);
  }

  // --- Daraja: get a token (cached when possible), then push the STK prompt ---
  let checkoutRequestId: string;
  try {
    const cfg = loadDarajaConfig();
    const token = await getDarajaToken(cfg);
    const stk = await initiateStkPush(cfg, token, {
      phone: phoneNumber,
      amount: plan.price,
      accountReference: "StacksRead",
      transactionDesc: "Reading Room",
    });
    checkoutRequestId = stk.checkoutRequestId;
  } catch (err) {
    console.error("stk-initiate Daraja error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }

  // --- Record the PENDING payment so stk-status / stk-callback can find it ---
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("stk-initiate: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: "Server misconfiguration (Supabase credentials)" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { error: insertError } = await supabase.from("mpesa_payments").insert({
    invoice_id: checkoutRequestId,
    phone_number: phoneNumber,
    amount: plan.price,
    plan_id: body.plan_id,
    plan_hours: plan.hours,
    status: "PENDING",
  });

  if (insertError) {
    console.error("stk-initiate insert error:", insertError);
    return json({ error: "Could not record the payment request" }, 500);
  }

  return json({ invoice_id: checkoutRequestId });
});
