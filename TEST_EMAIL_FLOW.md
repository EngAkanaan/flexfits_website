# FlexFits Email System - Complete Test Manual

**Last Updated**: March 18, 2026  
**Project**: flexfitsstore (formerly flexfitswebsite2026)  
**Environment**: localhost:3002 (development)

---

## Pre-Test Checklist

- [ ] Dev server running: `npm run dev` on http://localhost:3002
- [ ] `.env.local` configured with:
  - `VITE_EMAIL_WEBHOOK_URL` = Google Apps Script endpoint
  - `VITE_EMAIL_WEBHOOK_SECRET` = adamkanaan2004@flexfits.lb162005
  - `VITE_SITE_URL` = http://localhost:3000 (local) or https://flexfitsstore.vercel.app (production)
  - `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` configured
- [ ] Browser DevTools console visible (F12)
- [ ] Both Gmail inboxes ready to check:
  - Admin: flexfitslebanon@gmail.com
  - Test customer: (use any real email during checkout)

---

## Test Scenario 1: Order Created → Admin Email

### Steps

1. **Open the site**: Navigate to http://localhost:3002
2. **Add product to cart**: 
   - Browse Shop
   - Add any product (e.g., "Nike Air Force 1")
   - Select size and quantity
   - Add to cart
3. **Proceed to checkout**:
   - Click Cart icon → "Proceed to Checkout"
   - Fill checkout form:
     - Name: "Test Customer"
     - Email: `your-test-email@gmail.com` (use real email to receive dispatch notification later)
     - Phone: "+961-70-123456"
     - Governorate: "Mont-Liban"
     - District: "Aley"
     - Village: "Some Village"
     - Address Details: "Near the main mosque"
   - Click "Place Order"
4. **Expected**: Page shows "✅ Confirmed! Check your email"
5. **Check console** (F12 → Console tab):
   ```
   [email:success] order_created_admin -> flexfitslebanon@gmail.com
   "Form-encoded webhook POST succeeded (ok:true)."
   {orderId: "ORD-1740...", id: "mail-1740..."}
   ```
   - **Pass** = `[email:success]` and body contains "ok:true"
   - **Fallback** = `[email:fallback-unknown]` (Stage 2 or 3 used)
   - **Fail** = `[email:failed]` (all stages exhausted)

6. **Check Admin Gmail inbox** (flexfitslebanon@gmail.com):
   - Look for email subject: `New Order ORD-... - Test Customer`
   - Email should contain: order id, items table, customer details, admin button
   - **Pass** = Email arrives within 2 minutes
   - **Note** = May be in Spam; check Promotions/Spam folder

---

## Test Scenario 2: Order Dispatched → Customer Email

### Steps (Requires Test Scenario 1 to Complete First)

1. **Admin login**:
   - Click "Admin Panel" button (bottom right)
   - Credentials: **AdamFlex** / **Akanaan2025**
   - Wait for admin dashboard to load

2. **View Orders Tab**:
   - Scroll to "Orders" section
   - Find the test order (should show `ORD-...` and "Test Customer")
   - Status should be **"pending"**

3. **Approve & Dispatch**:
   - Click the order row or find "Approve Dispatch" action button
   - Confirm the dialog (if prompted)
   - Expected: Order status changes to **"shipped"**

4. **Check Console Again**:
   - Look for new log entry:
   ```
   [email:fallback-unknown] order_dispatched_customer -> your-test-email@gmail.com
   "Form request failed (...); sendBeacon fallback queued..."
   {orderId: "ORD-...", id: "mail-1740..."}
   ```
   - **Stages Used**:
     - Stage 1 (Form POST) = probably fails in localhost due to CORS or network
     - Stage 2 (sendBeacon) = usually succeeds and logs as "fallback-unknown"
     - Stage 3 (no-cors) = last resort

5. **Verify Customer Email** (your-test-email@gmail.com):
   - Check inbox for subject: `Your Flex Fits Order ORD-... is Confirmed`
   - Email should contain: order confirmation, items, dispatch message
   - **Pass** = Email arrives within 2 minutes
   - **Fallback Pass** = Even if sendBeacon logs "fallback-unknown", email should still arrive

---

## Test Scenario 3: Email Activity Log in Admin

### Steps

1. **Stay in Admin Panel**
2. **Scroll down** to the bottom to **"Email Activity Log"** section
3. **Expected entries** (newest first):
   - `order_dispatched_customer | your-test-email@gmail.com | Fallback-Unknown`
   - `order_created_admin | flexfitslebanon@gmail.com | Success`

4. **Click on each entry**:
   - Verify detail shows webhook attempt details
   - Look for reason (e.g., "sendBeacon fallback queued")

5. **"Destroy Log" button**:
   - Clears all localStorage entries (for fresh test)
   - Use if testing multiple times

---

## Failure Diagnosis Flowchart

### Email didn't arrive in inbox?

**Step 1**: Check Admin Activity Log
- [ ] Entry exists with Status = **Success** or **Fallback-Unknown**?
  - **YES** → Go to Step 2
  - **NO** → Go to Failure Case A

**Step 2**: Check Gmail filters/spam
- [ ] Check Spam/Promotions folder for the email?
  - **YES** → Mark as "Not Spam" and re-send order
  - **NO** → Go to Failure Case B

**Step 3**: Check Apps Script Executions
- [ ] Open Google Apps Script dashboard: https://script.google.com/home/projects
- [ ] Find your FlexFits email script
- [ ] Click "Executions" tab
- [ ] Look for recent (last 5 min) executions:
  - [ ] **Green checkmark** = Success (email sent via Gmail)
  - [ ] **Red X** = Failure (check error message)
  - [ ] **No entry** = Apps Script never triggered (webhook URL wrong or network issue)

---

### Failure Case A: No email log entry

**Cause**: Email event didn't trigger, or webhook timeout

**Checks**:
- [ ] Order actually created? (check "Orders" tab, should show new order)
- [ ] Console has any errors? (F12 → Console, look for red errors)
- [ ] VITE_EMAIL_WEBHOOK_URL correct in .env.local?
- [ ] Dev server restarted after .env change? (`npm run dev`)

**Fix**:
```bash
# Restart dev server
npm run dev

# Try order again
# Watch console for [email:failed] vs [email:success]
```

---

### Failure Case B: Log shows Success, but no email received

**Cause**: Apps Script executed but Gmail send failed

**Checks**:
- [ ] Apps Script > Executions panel: check error message
- [ ] Common errors:
  - `Gmail service unavailable` = Google rate limit or account issue
  - `Invalid recipient` = Email address typo in form
  - `Service error` = Apps Script code bug

**Fix**:
- [ ] Verify your Gmail account hasn't hit rate limits
- [ ] Check Apps Script error log for details
- [ ] Try sending test email directly from Gmail (proves account works)

---

### Failure Case C: Console shows **[email:failed]** on all stages

**Cause**: All 3 fallback stages exhausted

**Log detail will show**:
```
Form request failed (Network request failed); 
no-cors fallback failed (TypeError: network error).
```

**Checks**:
- [ ] VITE_EMAIL_WEBHOOK_URL reachable?
  - Open URL in browser tab directly: https://script.google.com/macros/s/AKfyc.../exec
  - Should show "Unauthorized" or similar (not 404 or timeout)
- [ ] Network/Firewall blocking Google?
  - Try curl: `curl -X POST <webhook-url>`
- [ ] VITE_EMAIL_WEBHOOK_SECRET correct in .env.local?

**Fix**:
```bash
# Verify webhook URL is live
Start-Process "https://script.google.com/macros/s/AKfycb.../exec"

# Restart dev server with fresh env
npm run dev
```

---

## Test Scenario 4: Idempotency (Re-Dispatch Same Order)

### Steps

1. **In Admin Panel**, find the dispatched order (now Status = "shipped")
2. **Try clicking "Approve Dispatch" again** on same order
3. **Expected**:
   - [ ] Stock should NOT deduct twice (check inventory in "Products" tab)
   - [ ] NO new email should be sent (or if it is, email log shows success still, no duplicate)
   - [ ] Console should show message like: "Order already shipped" or similar

4. **Verify in Products tab**:
   - Product sold/pieces counts should match first dispatch, not doubled

---

## Test Scenario 5: Vercel Production Deployment

### When ready (after local tests pass):

1. **Update .env.local for production**:
   ```env
   VITE_SITE_URL=https://flexfitsstore.vercel.app
   ```

2. **Push to GitHub**:
   ```bash
   git add .
   git commit -m "Email system ready for production: sendBeacon fallbackchain + env updated for flexfitsstore"
   git push origin main
   ```

3. **Vercel auto-redeploys** from GitHub

4. **Set Vercel Project Env Variables**:
   - Go to Vercel Dashboard > Project Settings > Environment Variables
   - Add:
     - `VITE_EMAIL_WEBHOOK_URL` = same Google Apps Script URL
     - `VITE_EMAIL_WEBHOOK_SECRET` = same secret
     - `VITE_SITE_URL` = https://flexfitsstore.vercel.app
     - `VITE_SUPABASE_URL` = same
     - `VITE_SUPABASE_ANON_KEY` = same

5. **Test on https://flexfitsstore.vercel.app**:
   - Place test order
   - Check console for email success/fallback logs
   - Verify admin email arrives
   - Dispatch and verify customer email arrives

---

## Expected Outcomes Summary

| Test | Expected Result | Status |
|------|-----------------|--------|
| Order → Admin Email | `[email:success]` or `[email:fallback-unknown]` in console, email in inbox | ✅ Should Pass |
| Order → Admin Activity Log | Entry shows in admin dashboard within 5 sec | ✅ Should Pass |
| Dispatch → Customer Email | `[email:fallback-unknown]` (sendBeacon), email in inbox | ✅ Should Pass |
| Dispatch → Inventory Decrements | Pieces decrease by order qty, sold increase by order qty | ✅ Should Pass |
| Re-Dispatch Same Order | No double deduction of inventory | ✅ Should Pass |
| Apps Script Executions | Green checkmark entries, no errors | ✅ Should Pass |

---

## Commands for Quick Reference

```bash
# Start dev server
npm run dev

# Build for production
npm run build

# Clear email log (admin panel)
# Click "Destroy Log" in Email Activity Log section

# Check env variables are loaded
# Open browser console: console.log(import.meta.env.VITE_EMAIL_WEBHOOK_URL)
```

---

## What Each Fallback Stage Means

| Stage | Name | When Used | Success Indicator |
|-------|------|-----------|-------------------|
| 1 | Form-Encoded POST | Always first | `[email:success]` in console, receives `{ok:true}` response |
| 2 | sendBeacon | If Stage 1 fails | `[email:fallback-unknown]`, queued=true returned |
| 3 | no-cors Fetch | If Stage 1 & 2 fail | `[email:fallback-unknown]`, no error thrown |
| None | Failed | All 3 fail | `[email:failed]`, check error detail |

---

**Next Steps After All Tests Pass**:
1. Verify no console errors
2. Check Gmail inboxes (both admin and customer)
3. Check Apps Script execution panel
4. Commit with `git commit -m "Email system tested and verified"`
5. Deploy to Vercel with new project name
6. Repeat tests on production domain
