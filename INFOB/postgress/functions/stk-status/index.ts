// stk-status/index.ts
// Called repeatedly (every few seconds) by the front end while it shows
// "Waiting for approval…". Body: { invoice_id: string }
// Returns: { state: "PENDING" | "COMPLETE" | "FAILED" }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

  let body: { invoice_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const invoiceId = (body.invoice_id || "").trim();
  if (!invoiceId) return json({ error: "invoice_id is required" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("stk-status: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: "Server misconfiguration (Supabase credentials)" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data, error } = await supabase
    .from("mpesa_payments")
    .select("status")
    .eq("invoice_id", invoiceId)
    .maybeSingle();

  if (error) {
    console.error("stk-status: query failed", error);
    return json({ error: "Could not look up payment status" }, 500);
  }
  if (!data) return json({ error: "Unknown invoice_id" }, 404);

  return json({ state: data.status });
});
