# Email Architecture Flowchart

## High-Level Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                     FLEXFITS EMAIL SYSTEM v2.0                       │
└──────────────────────────────────────────────────────────────────────┘


TRIGGER POINT 1: ORDER CREATED
===============================

  Customer Places Order
           ↓
  ┌────────────────────────────┐
  │  saveOrder() function      │
  │  [services/database.ts]    │
  └────────────┬───────────────┘
               ├─ Save to Supabase
               ├─ Sync to localStorage
               └─ Call: notifyAdminOrderCreated(order)
                        ↓
               ┌────────────────────────────┐
               │ Event: order_created_admin │
               │ Recipient:                 │
               │   flexfitslebanon@gmail.com│
               │ Email Content:             │
               │   • Order ID               │
               │   • Order items table      │
               │   • Customer details      │
               │   • Total price           │
               │   • Dashboard link        │
               └────────┬───────────────────┘
                        │
                        ▼
               ┌────────────────────────────┐
               │  sendEmailEvent() called   │
               │  ⚡ 3-STAGE FALLBACK ⚡   │
               └────────┬───────────────────┘


┌─────────────────────────────────────────────────────────────────────┐
│              3-STAGE EMAIL DELIVERY FALLBACK CHAIN                  │
└─────────────────────────────────────────────────────────────────────┘

STAGE 1: PRIMARY DELIVERY
─────────────────────────

  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: URLSearchParams({
      secret: EMAIL_WEBHOOK_SECRET,
      event: 'order_created_admin',
      toEmail: recipient,
      subject: email_subject,
      html: email_html,
      order: JSON.stringify(order),
      items: JSON.stringify(items)
    })
  })

  ┌─ Response OK? ──→ Response body has {ok: true}?
  │
  YES ✅                              NO ❌
  │                                    │
  ├─ Log: "success"                    ├─ Log: "failed"
  ├─ Push to localStorage              ├─ Try Stage 2
  └─ DONE                              └─ (continue fallback)


STAGE 2: SENDBEACON FALLBACK (NEW!)
────────────────────────────────────

  if (typeof navigator.sendBeacon === 'function') {
    const payload = JSON.stringify(emailPayload);
    const blob = new Blob([payload], { type: 'text/plain' });
    const queued = navigator.sendBeacon(WEBHOOK_URL, blob);
  }

  ┌─ Queued OK? ────→ Browser accepted request?
  │
  YES ✅                              NO ❌
  │                                    │
  ├─ Log: "fallback-unknown"           ├─ Log: "fallback-unknown"
  ├─ Push to localStorage              ├─ Try Stage 3
  ├─ Note: delivery unverified         └─ (continue fallback)
  └─ DONE


STAGE 3: NO-CORS FINAL FALLBACK
────────────────────────────────

  fetch(WEBHOOK_URL, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(emailPayload)
  })

  ┌─ No error thrown?
  │
  YES ✅                              NO ❌
  │                                    │
  ├─ Log: "fallback-unknown"           ├─ Log: "failed"
  ├─ Push to localStorage              ├─ Push to localStorage
  ├─ Note: delivery unverified         └─ ALL STAGES EXHAUSTED
  └─ DONE                                 (retry mechanism: none)


LOG ENTRIES PRODUCED
════════════════════

  SUCCESS:
    {
      id: "mail-1740...",
      ts: "2026-03-18T14:30:00.000Z",
      event: "order_created_admin",
      toEmail: "flexfitslebanon@gmail.com",
      subject: "New Order ORD-123 - John Doe",
      orderId: "ORD-123",
      status: "success",           ✅
      stage: "primary",
      detail: "Form-encoded webhook POST succeeded (ok:true)."
    }

  FALLBACK:
    {
      id: "mail-1740...",
      ts: "2026-03-18T14:30:00.000Z",
      event: "order_created_admin",
      orderId: "ORD-123",
      status: "fallback-unknown",  ⚠️
      stage: "fallback",
      detail: "Form req failed (...); sendBeacon fallback queued..."
    }

  FAILED:
    {
      id: "mail-1740...",
      ts: "2026-03-18T14:30:00.000Z",
      event: "order_created_admin",
      status: "failed",            ❌
      stage: "fallback",
      detail: "Form failed (...); no-cors failed (network error)."
    }


WEBHOOK ENDPOINT (GOOGLE APPS SCRIPT)
══════════════════════════════════════

  Google Apps Script receives POST request
                 ↓
  ┌──────────────────────────────┐
  │ doPost(e) handler            │
  │ 1. Extract form data         │
  │ 2. Validate secret           │
  │ 3. Parse JSON payloads       │
  │ 4. Call Gmail service        │
  │ 5. Return response           │
  └────────────┬─────────────────┘
               │
      ┌────────┴────────┐
      │                 │
   SUCCESS          FAILURE
      │                 │
      ▼                 ▼
  {ok:true}    {ok:false, error:"..."}
                or Exception thrown


GMAIL DELIVERY
══════════════

  Gmail service receives email
         ↓
  ┌─────────────────┐
  │ Recipient email │
  │ • Admin inbox   │
  │ • Or spam       │
  │ • Or bounced    │
  └─────────────────┘


OBSERVABILITY
═════════════

  Browser Console (F12):
    [email:success] order_created_admin -> flexfitslebanon@gmail.com
    "Form-encoded webhook POST succeeded (ok:true)."
    {orderId: "ORD-123", id: "mail-1740..."}

  Admin Dashboard:
    Admin Panel → Email Activity Log
    Shows: [123 success | 45 fallback | 2 failed]
    View details, timestamp, reason for each

  Apps Script Executions:
    https://script.google.com/home/projects
    [Your script] → Executions
    ✅ Green = success
    ❌ Red = error
    (no entry = webhook never called)

  Gmail Inbox:
    flexfitslebanon@gmail.com
    Subject: New Order ORD-123 - John Doe
    Body: Formatted HTML with order details
    Status: Inbox or Spam folder
           └─ Mark as "Not Spam" if needed


TRIGGER POINT 2: ORDER DISPATCHED
═══════════════════════════════════

  Admin clicks "Approve Dispatch"
         ↓
  ┌────────────────────────────┐
  │  updateOrderStatus() call   │
  │  pending → shipped          │
  │  [services/database.ts]    │
  └────────────┬───────────────┘
               ├─ Validate stock availability
               ├─ Update product inventory
               │  • Items_LEFT_in_stock -= qty
               │  • Items_Sold += qty
               │  • Status = "Temporarily unavailable" if 0 left
               ├─ Update order status to "shipped"
               ├─ Recalculate financial metrics
               └─ Call: notifyCustomerOrderDispatched(order)
                        ↓
               ┌────────────────────────────┐
               │ Event: order_dispatched_   │
               │        customer            │
               │ Recipient:                 │
               │   order.customerEmail      │
               │ Email Content:             │
               │   • Order confirmation     │
               │   • Same order items       │
               │   • Dispatch notice        │
               └────────┬───────────────────┘
                        │
                        ▼
               (SAME 3-STAGE FALLBACK AS ABOVE)


DELIVERY TIMELINE
═════════════════

  T+0ms:      Customer clicks "Place Order"
  T+50ms:     Order saved to Supabase
  T+75ms:     Email event created
  T+100ms:    Stage 1 (Form POST) attempt starts
  T+250ms:    Stage 1 result known (success or fail)
  T+300ms:    (If fail) Stage 2 (sendBeacon) attempt
  T+350ms:    (If still fail) Stage 3 (no-cors) attempt
  T+400ms:    ✅ Page says "Confirmed! Check your email"
  T+1min:     Email appears in Gmail inbox (or spam)


AVAILABILITY TARGETS
═════════════════════

  Stage 1 Success Rate:        ~80% (good networks, fast DNS)
  Stage 1 + Stage 2 Combined:  ~95% (includes slow/unreliable)
  All 3 Stages Combined:       ~99% (unless webhook URL down)

  Email Inbox Delivery:        ~98% (if Apps Script runs)
  Gmail Spam Filter Risk:      ~5% (may go to Promotions)


SECURITY CONSIDERATIONS
═════════════════════════

  ⚠️ Webhook Secret:
     • Currently: adamkanaan2004@flexfits.lb162005
     • Visible in: Chat history, .env.local
     • Action: ROTATE after production verified

  ⚠️ Google Apps Script URL:
     • Currently: Public (in frontend code)
     • Risk: Anyone can call webhook
     • Mitigation: Secret validation + rate limiting (TODO)

  ⚠️ Supabase Keys:
     • Currently: Anon key in browser
     • Standard: Expected for Supabase auth flow
     • Action: ROTATE after launch


TESTING WORKFLOW
═════════════════

  See: TEST_EMAIL_FLOW.md for complete procedures

  Quick Verification (5 min):
    1. Place order with real test email
    2. F12 console: [email:success] or [email:fallback-unknown]
    3. Check flexfitslebanon@gmail.com for new order email
    ✅ If all 3 appear: Email system working

  Full Test Suite (20 min):
    1. Complete 5 test scenarios
    2. Verify admin log shows entries
    3. Verify Apps Script executions show success
    4. Test failure cases (if needed)
    ✅ If all pass: Ready for production

  Production Verification:
    1. Set Vercel environment variables
    2. Run same tests on production domain
    3. Rotate secrets
    ✅ Ready for live traffic


TROUBLESHOOTING QUICK LINKS
════════════════════════════

  Q: Email not received
  A: TEST_EMAIL_FLOW.md → Failure Diagnosis Flowchart

  Q: Why "fallback-unknown"?
  A: IMPLEMENTATION_COMPLETE.md → Test Results Summary

  Q: How to rotate secrets?
  A: README_IMPLEMENTATION.md → "Then: Deploy to Vercel"

  Q: What's sendBeacon?
  A: IMPLEMENTATION_COMPLETE.md → "Why sendBeacon Added?"

  Q: Need to reset?
  A: Admin Panel → Email Activity Log → "Destroy Log" button
