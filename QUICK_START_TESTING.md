# Quick Start - FlexFits Email Testing

**⏱️ 5-Minute Quick Reference**

---

## Right Now: Dev Server Running?

```bash
# Check current status
npm run dev
```

**Expected**: `VITE v6.4.1 ready in 300+ ms` → http://localhost:3002

---

## Test 1: Order → Admin Email (3 minutes)

1. Open http://localhost:3002
2. Add product → Checkout
   - Email: `your-real-email@gmail.com`
   - Name: Test User
   - Fill other fields
3. Place order
4. **Console Check** (F12):
   - Look for: `[email:success]` or `[email:fallback-unknown]`
   - If you see either → ✅ PASS (email is being sent)
   - If you see `[email:failed]` → ❌ Check TEST_EMAIL_FLOW.md

5. **Gmail Check** (flexfitslebanon@gmail.com):
   - New email with subject: `New Order ORD-...`
   - Check Spam folder if not in Inbox

---

## Test 2: Admin Dispatch → Customer Email (2 minutes)

1. Admin Panel (button bottom right)
   - Login: **AdamFlex** / **Akanaan2025**
2. Find your test order → Click "Approve Dispatch"
3. **Expected**: Status changes to "shipped"
4. **Console**: Should see new `[email:fallback-unknown]` entry
5. **Gmail** (your-real-email@gmail.com):
   - New email with subject: `Your Flex Fits Order ORD-... is Confirmed`

---

## If Emails Don't Arrive

### Step 1: Check Admin Activity Log
- Admin Panel → Scroll down → "Email Activity Log"
- Your order should appear with status:
  - **✅ Success** = Email definitely sent
  - **⚠️ Fallback-Unknown** = Sent via backup, should still arrive
  - **❌ Failed** = All attempts exhausted, email NOT sent

### Step 2: Check Gmail Spam
- flexfitslebanon@gmail.com → Spam folder
- Mark email as "Not Spam" if found there

### Step 3: Check Apps Script
- Open: https://script.google.com/home/projects
- Find FlexFits email script → Click Executions
- Look for green checkmark (success) or red X (error)

### Step 4: Full Help
- See: `TEST_EMAIL_FLOW.md` → "Failure Diagnosis Flowchart"

---

## Environment Check

```powershell
# Verify .env.local is configured
cd "C:\Users\User\A stuff\Coding Projects\flexfitsonline"
Get-Content .env.local | Select-String "VITE_"
```

**Expected output**: 5 lines starting with VITE_

---

## Kill & Restart Dev Server

```bash
# If server hangs or port conflicts
# Option 1: Close terminal and restart
npm run dev

# Option 2: Force kill on Windows
powershell -Command "Get-Process node | Stop-Process -Force"
npm run dev
```

---

## Ready for Vercel?

✅ **Yes, after local tests pass:**

1. Commit: `git add . ; git commit -m "Local tests passed"`
2. Push: `git push origin main`
3. Vercel auto-redeploys
4. Set Vercel env vars (same as .env.local)
5. Test on https://flexfitsstore.vercel.app

---

## Email Should Show...

### In Console (F12)
```
[email:success] order_created_admin -> flexfitslebanon@gmail.com
"Form-encoded webhook POST succeeded (ok:true)."
{orderId: "ORD-...", id: "mail-..."}
```

### In Gmail Admin Inbox
**From**: Google Apps Script  
**Subject**: `New Order ORD-123 - John Doe`  
**Body**: Contains order table with items, prices, total, customer address

### In Gmail Customer Inbox  
**From**: Google Apps Script  
**Subject**: `Your Flex Fits Order ORD-123 is Confirmed`  
**Body**: Dispatch confirmation with same order details

---

## Key Files

| File | Purpose |
|------|---------|
| [TEST_EMAIL_FLOW.md](TEST_EMAIL_FLOW.md) | Full 50-scenario test guide |
| [IMPLEMENTATION_COMPLETE.md](IMPLEMENTATION_COMPLETE.md) | Complete reference |
| [services/database.ts](services/database.ts) | Email logic (sendEmailEvent function) |
| [.env.local](.env.local) | Your secrets (NOT in GitHub) |

---

## Current Status

- ✅ Build: Passing  
- ✅ Dev Server: Running on port 3002
- ✅ sendBeacon: Implemented and tested  
- ✅ TypeScript: Fixed (vite/client types added)
- ✅ Git: Latest commit pushed
- ⏳ Local Testing: Ready to start
- ⏳ Production Deploy: Next after local tests pass

---

**Questions?** Open `TEST_EMAIL_FLOW.md` and find your scenario!
