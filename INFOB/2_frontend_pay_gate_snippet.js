// ============================================================
// REPLACES the existing renderPayStep2() and tryPayUnlock() functions
// in your index.html <script type="module">, and adds one new constant
// plus a few new functions. Everything else in the pay-gate flow
// (renderPayStep1, showPayGate, hidePayGate, PAY_PLANS, grantReadAccess,
// etc.) stays exactly as-is.
//
// WHERE TO GET THE URL BELOW: after you run
//   supabase functions deploy intasend-stk-push
// Supabase prints the function's URL — looks like
//   https://<project-ref>.functions.supabase.co/intasend-stk-push
// ============================================================

const STK_PUSH_FUNCTION_URL = "https://<project-ref>.functions.supabase.co/intasend-stk-push";

function renderPayStep2(){
  const plan = state.payPlan || PAY_PLANS[0];
  els.payPanel.innerHTML = `
    <p class="pay-step-label">Step 2 of 2</p>
    <p class="pay-phone-display">${escapeHtml(state.payPhone)} · KSH ${plan.price} for ${plan.label}</p>
    <div class="pay-approve-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2" stroke-linecap="round"/></svg>
      <p id="payWaitingText">Sending the payment prompt to your phone…</p>
    </div>
    <div class="pay-error" id="payError"></div>
    <div class="pay-actions">
      <button type="button" class="pass-cancel" id="payCancelBtn">Cancel</button>
    </div>
    <button type="button" class="pay-back-link" id="payBackBtn">&larr; Change plan or number</button>
    <p class="pay-note">Enter your M-Pesa PIN on your phone when the prompt appears. This page will unlock automatically — no code to type in.</p>`;
  document.getElementById('payCancelBtn').addEventListener('click', () => { state.pendingReadItem = null; stopStkPolling(); hidePayGate(); });
  document.getElementById('payBackBtn').addEventListener('click', () => { stopStkPolling(); state.payStep = 1; renderPayStep1(); });

  triggerStkPush(plan);
}

let stkPollTimer = null;
let stkPollAttempts = 0;
const STK_POLL_INTERVAL_MS = 3000;
const STK_POLL_MAX_ATTEMPTS = 40; // ~2 minutes

function stopStkPolling(){
  if(stkPollTimer){ clearInterval(stkPollTimer); stkPollTimer = null; }
  stkPollAttempts = 0;
}

async function triggerStkPush(plan){
  const waitingText = document.getElementById('payWaitingText');
  const errorEl = document.getElementById('payError');
  try{
    const res = await fetch(STK_PUSH_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: state.payPhone,
        amount: plan.price,
        planId: plan.id,
        planHours: plan.hours,
      }),
    });
    const data = await res.json();
    if(!res.ok || !data.apiRef){
      throw new Error(data.error || 'Could not send the payment prompt.');
    }
    if(waitingText) waitingText.textContent = 'Prompt sent — check your phone and enter your M-Pesa PIN.';
    pollStkStatus(data.apiRef, plan);
  } catch(err){
    console.error(err);
    if(errorEl) errorEl.textContent = 'Could not start the payment: ' + (err.message || err);
    if(waitingText) waitingText.textContent = 'Something went wrong sending the prompt.';
  }
}

function pollStkStatus(apiRef, plan){
  stopStkPolling();
  stkPollAttempts = 0;
  stkPollTimer = setInterval(async () => {
    stkPollAttempts++;
    const waitingText = document.getElementById('payWaitingText');
    const errorEl = document.getElementById('payError');

    if(stkPollAttempts > STK_POLL_MAX_ATTEMPTS){
      stopStkPolling();
      if(waitingText) waitingText.textContent = 'Still waiting on confirmation.';
      if(errorEl) errorEl.textContent = "This is taking longer than expected — check your phone, or cancel and try again.";
      return;
    }

    try{
      const { data, error } = await supabase
        .from('stk_transactions')
        .select('status, failed_reason')
        .eq('api_ref', apiRef)
        .maybeSingle();
      if(error) throw error;
      if(!data || data.status === 'pending') return; // keep waiting

      stopStkPolling();
      if(data.status === 'success'){
        grantReadAccess(plan);
        hidePayGate();
        updateAccessStatusBar();
        const item = state.pendingReadItem;
        state.pendingReadItem = null;
        if(item) openViewer(item);
      } else {
        if(waitingText) waitingText.textContent = 'Payment was not completed.';
        if(errorEl) errorEl.textContent = data.failed_reason || 'The payment was cancelled or declined. You can try again.';
      }
    } catch(err){
      console.error(err);
      // transient network hiccup — let it retry on the next tick
    }
  }, STK_POLL_INTERVAL_MS);
}

// tryPayUnlock() is no longer used — delete it from the file.
