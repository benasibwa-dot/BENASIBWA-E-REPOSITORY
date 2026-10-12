// stk-callback/index.ts
// This URL is what you set as DARAJA_CALLBACK_URL and register with Daraja.
// Safaricom's servers POST here — the customer's browser never calls this.
// It must be publicly reachable (Supabase Edge Functions are, by default,
// at https://<project-ref>.functions.supabase.co/stk-callback).
//
// Expected body shape (Daraja "stkCallback"):
// {
//   "Body": {
//     "stkCallback": {
//       "MerchantRequestID": "...",
//       "CheckoutRequestID": "...",
//       "ResultCode": 0,
//       "ResultDesc": "The service request is processed successfully.",
//       "CallbackMetadata": { "Item": [ { "Name": "Amount", "Value": 3 }, ... ] }  // only on success
//     }
//   }
// }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    console.error("stk-callback: invalid JSON body");
    // Still 200 — Daraja will retry on non-2xx, which we don't want for a bad body.
    return json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const cb = payload?.Body?.stkCallback;
  if (!cb || !cb.CheckoutRequestID) {
    console.error("stk-callback: missing stkCallback / CheckoutRequestID", payload);
    return json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const invoiceId: string = cb.CheckoutRequestID;
  const resultCode: number = cb.ResultCode;
  const resultDesc: string = cb.ResultDesc || "";

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("stk-callback: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    // Acknowledge anyway so Daraja doesn't hammer retries; the payment is
    // still logged on Safaricom's side and can be reconciled manually.
    return json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const status = resultCode === 0 ? "COMPLETE" : "FAILED";

  const { error } = await supabase
    .from("mpesa_payments")
    .update({
      status,
      failed_reason: resultCode === 0 ? null : resultDesc,
      updated_at: new Date().toISOString(),
    })
    .eq("invoice_id", invoiceId);

  if (error) {
    console.error("stk-callback: update failed", error, "invoice_id:", invoiceId);
  }

  // Always acknowledge with HTTP 200 + ResultCode 0 so Safaricom marks the
  // callback as delivered and doesn't keep retrying it.
  return json({ ResultCode: 0, ResultDesc: "Accepted" });
});
