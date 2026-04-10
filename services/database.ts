// Database service layer for Supabase operations
// This will replace localStorage with real database calls

import { supabase } from './supabase';
import { Product, ProductGender, ProductSizeStock, Order, FinancialMetric, FinancialTotals, StockReservation } from '../types';

const ADMIN_NOTIFICATION_EMAIL = 'flexfitslebanon@gmail.com';
const EMAIL_WEBHOOK_URL = String(import.meta.env.VITE_EMAIL_WEBHOOK_URL || '').trim();
const EMAIL_WEBHOOK_SECRET = String(import.meta.env.VITE_EMAIL_WEBHOOK_SECRET || '').trim();
const SITE_URL = String(
  import.meta.env.VITE_SITE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000')
).trim();
const DEFAULT_PRODUCT_IMAGE = '/flex-logo-bbg.JPG';
const PRODUCT_IMAGE_BUCKET = String(import.meta.env.VITE_SUPABASE_PRODUCT_IMAGE_BUCKET || 'product-images').trim() || 'product-images';
const MAX_UPLOAD_IMAGE_BYTES = 50 * 1024 * 1024;
const ALLOWED_UPLOAD_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const RESERVATION_TTL_SECONDS = 10 * 60;
const RESERVATION_SESSION_STORAGE_KEY = 'flex_reservation_session_id';
const LOCAL_RESERVATION_STORAGE_KEY = 'flex_stock_reservations_local';

type EmailOrderItem = {
  productId: string;
  productName: string;
  quantity: number;
  size: string;
  price: number;
  image?: string;
};

type EmailLogStatus = 'success' | 'failed' | 'fallback-unknown';

type EmailDeliveryLog = {
  id: string;
  ts: string;
  event: 'order_created_admin' | 'order_received_customer' | 'order_dispatched_customer';
  toEmail: string;
  subject: string;
  orderId: string;
  status: EmailLogStatus;
  stage: 'primary' | 'fallback';
  detail: string;
};

const EMAIL_LOG_STORAGE_KEY = 'flex_email_delivery_logs';

function pushEmailLog(entry: EmailDeliveryLog): void {
  try {
    const existingRaw = localStorage.getItem(EMAIL_LOG_STORAGE_KEY);
    const existing = existingRaw ? (JSON.parse(existingRaw) as EmailDeliveryLog[]) : [];
    const next = [entry, ...existing].slice(0, 80);
    localStorage.setItem(EMAIL_LOG_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore localStorage failures silently to avoid breaking order flow.
  }

  const prefix = `[email:${entry.status}] ${entry.event} -> ${entry.toEmail}`;
  if (entry.status === 'failed') {
    console.error(prefix, entry.detail, { orderId: entry.orderId, id: entry.id });
  } else {
    console.info(prefix, entry.detail, { orderId: entry.orderId, id: entry.id });
  }
}

function formatMoney(value: number): string {
  return `$${Math.max(0, Number(value || 0)).toFixed(2)}`;
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function redactSensitiveText(value: string): string {
  if (!value) return '';
  let safe = String(value);

  if (EMAIL_WEBHOOK_SECRET) {
    safe = safe.split(EMAIL_WEBHOOK_SECRET).join('[redacted]');
  }

  safe = safe.replace(/(secret=)[^&\s]*/gi, '$1[redacted]');
  safe = safe.replace(/("secret"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2');
  return safe;
}

function classifyWebhookResponse(bodyText: string): { success: boolean; detail: string } {
  const raw = String(bodyText || '');
  const trimmed = raw.trim();

  if (!trimmed) {
    return {
      success: false,
      detail: 'Unexpected webhook response: [empty body]',
    };
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = null;
  }

  if (parsed && parsed.ok === true) {
    return {
      success: true,
      detail: 'Form-encoded webhook POST succeeded (ok:true).',
    };
  }

  if (parsed && parsed.error) {
    return {
      success: false,
      detail: String(parsed.error),
    };
  }

  const normalized = trimmed.toLowerCase();
  const plainSuccessTokens = ['ok', 'success', 'sent', 'email sent'];
  if (plainSuccessTokens.includes(normalized)) {
    return {
      success: true,
      detail: `Form-encoded webhook POST succeeded (plain-text response: ${normalized}).`,
    };
  }

  // Some Apps Script deployments echo form data back as plain text on success.
  const looksLikeEchoedFormPayload = /(^|&)event=[^&]+(&|$)/i.test(trimmed) && /(^|&)toEmail=[^&]+(&|$)/i.test(trimmed);
  if (looksLikeEchoedFormPayload) {
    return {
      success: true,
      detail: 'Form-encoded webhook POST succeeded (Apps Script returned echoed form payload).',
    };
  }

  const safeSnippet = redactSensitiveText(trimmed).slice(0, 240);
  return {
    success: false,
    detail: `Unexpected webhook response: ${safeSnippet}`,
  };
}

function normalizeProductImage(value: any): string {
  const candidate = normalizeImageSourceToken(value);
  return candidate || DEFAULT_PRODUCT_IMAGE;
}

function isValidDataImageUrl(value: string): boolean {
  if (!/^data:image\//i.test(value)) return false;
  return /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(value);
}

function isValidHttpImageUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isValidLocalImagePath(value: string): boolean {
  // Keep local path support explicit to avoid treating random base64 fragments as relative URLs.
  return /^\/[\w./%+-]+$/i.test(value);
}

function normalizeImageSourceToken(value: any): string | null {
  const candidate = String(value || '').trim();
  if (!candidate) return null;
  if (/^https?:\/\/via\.placeholder\.com\//i.test(candidate)) return null;
  if (isValidHttpImageUrl(candidate) || isValidLocalImagePath(candidate) || isValidDataImageUrl(candidate)) {
    return candidate;
  }
  return null;
}

function sanitizeStorageFileName(name: string): string {
  return String(name || 'image')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || 'image';
}

export async function uploadProductImagesToStorage(productId: string, files: File[]): Promise<string[]> {
  const selected = (files || []).filter((file) => file && Number(file.size || 0) > 0);
  if (!supabase || selected.length === 0) return [];

  const uploadedUrls: string[] = [];
  for (const file of selected) {
    const normalizedType = String(file.type || '').toLowerCase();
    if (!ALLOWED_UPLOAD_IMAGE_TYPES.has(normalizedType)) {
      throw new Error(`Unsupported image type for ${file.name}. Allowed: JPG, PNG, WEBP, GIF.`);
    }

    if (Number(file.size || 0) > MAX_UPLOAD_IMAGE_BYTES) {
      throw new Error(`Image ${file.name} exceeds 50MB upload limit.`);
    }

    const ext = String(file.name || '').split('.').pop() || 'jpg';
    const cleanName = sanitizeStorageFileName(file.name || `upload-${Date.now()}.${ext}`);
    const objectPath = `${String(productId || 'product').trim()}/${Date.now()}-${cleanName}`;
    const { error } = await supabase.storage
      .from(PRODUCT_IMAGE_BUCKET)
      .upload(objectPath, file, {
        upsert: false,
        contentType: file.type || undefined,
      });

    if (error) {
      const lowerMessage = String(error.message || '').toLowerCase();
      if (lowerMessage.includes('bucket') && (lowerMessage.includes('not found') || lowerMessage.includes('does not exist'))) {
        throw new Error(`Image upload failed: bucket \"${PRODUCT_IMAGE_BUCKET}\" does not exist. Run migration 008_storage_product_images_setup.sql.`);
      }
      if (lowerMessage.includes('new row violates row-level security policy') || lowerMessage.includes('row level security')) {
        throw new Error(`Image upload failed due to storage policy restrictions for bucket \"${PRODUCT_IMAGE_BUCKET}\". Run migration 008_storage_product_images_setup.sql and ensure insert policy exists for current role.`);
      }
      if (lowerMessage.includes('row level security') || lowerMessage.includes('permission') || lowerMessage.includes('unauthorized')) {
        throw new Error(`Image upload failed due to storage policy restrictions on bucket \"${PRODUCT_IMAGE_BUCKET}\".`);
      }
      throw new Error(`Image upload failed for ${file.name}: ${error.message}`);
    }

    const { data } = supabase.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(objectPath);
    const publicUrl = String(data.publicUrl || '').trim();
    if (!publicUrl) {
      throw new Error(`Image upload succeeded but no public URL was returned for ${file.name}.`);
    }
    uploadedUrls.push(publicUrl);
  }

  return uploadedUrls;
}

function normalizeGender(value: any): ProductGender {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'women' || normalized === 'woman' || normalized === 'female' || normalized === 'ladies') return 'Women';
  if (normalized === 'men' || normalized === 'man' || normalized === 'male' || normalized === 'gents') return 'Men';
  if (normalized === 'unisex' || normalized === 'uni-sex') return 'Unisex';
  return 'Unisex';
}

function inferGenderFromRow(row: any): ProductGender {
  const explicit = row.Gender ?? row.gender ?? row.Product_Gender ?? row.product_gender;
  if (String(explicit || '').trim()) return normalizeGender(explicit);

  const hintText = [
    row.Name_of_Product,
    row.Name_Product,
    row.name_of_product,
    row.Name_of_Item,
    row.name_of_item,
    row.Type,
    row.type,
    row.Description,
    row.description,
  ]
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  if (/(\bwomen\b|\bwoman\b|\bfemale\b|\bladies\b)/i.test(hintText)) return 'Women';
  if (/(\bmen\b|\bman\b|\bmale\b|\bgents\b)/i.test(hintText)) return 'Men';
  if (/\bunisex\b/i.test(hintText)) return 'Unisex';
  return 'Unisex';
}

function buildOrderEmailHtml(
  order: Order,
  items: EmailOrderItem[],
  title: string,
  intro: string
): string {
  const rows = items
    .map((item) => {
      const imageHtml = item.image
        ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.productName)}" style="width:56px;height:56px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;" />`
        : '<div style="width:56px;height:56px;border-radius:8px;border:1px solid #e5e7eb;background:#f9fafb;"></div>';

      return `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #f1f5f9;">${imageHtml}</td>
          <td style="padding:10px;border-bottom:1px solid #f1f5f9;font-weight:700;color:#111827;">${escapeHtml(item.productName)}</td>
          <td style="padding:10px;border-bottom:1px solid #f1f5f9;">${escapeHtml(item.size)}</td>
          <td style="padding:10px;border-bottom:1px solid #f1f5f9;">${item.quantity}</td>
          <td style="padding:10px;border-bottom:1px solid #f1f5f9;">${formatMoney(item.price)}</td>
        </tr>
      `;
    })
    .join('');

  const totalQty = items.reduce((acc, item) => acc + Math.max(0, Number(item.quantity || 0)), 0);
  const location = `${order.governorate}, ${order.district}, ${order.village}`;

  return `
    <div style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;">
      <div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;">
        <div style="background:#111827;color:#ffffff;padding:18px 20px;">
          <div style="font-size:18px;font-weight:800;">Flex Fits</div>
          <div style="font-size:13px;opacity:0.9;">${escapeHtml(title)}</div>
        </div>
        <div style="padding:20px;color:#111827;">
          <p style="margin:0 0 12px;font-size:14px;">${escapeHtml(intro)}</p>
          <p style="margin:0 0 16px;font-size:13px;color:#475569;">
            Order ID: <strong>${escapeHtml(order.id)}</strong><br />
            Date: <strong>${escapeHtml(new Date(order.date).toLocaleString())}</strong>
          </p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:14px;">
            <thead>
              <tr style="text-align:left;background:#f8fafc;color:#475569;">
                <th style="padding:10px;">Image</th>
                <th style="padding:10px;">Item</th>
                <th style="padding:10px;">Size</th>
                <th style="padding:10px;">Qty</th>
                <th style="padding:10px;">Price</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin:0 0 6px;font-size:13px;">Total Items: <strong>${totalQty}</strong></p>
          <p style="margin:0 0 6px;font-size:13px;">Order Total: <strong>${formatMoney(order.total)}</strong></p>
          <p style="margin:0 0 6px;font-size:13px;">Customer: <strong>${escapeHtml(order.customerName)}</strong> (${escapeHtml(order.customerEmail)})</p>
          <p style="margin:0 0 6px;font-size:13px;">Phone: <strong>${escapeHtml(order.customerPhone)}</strong></p>
          <p style="margin:0 0 6px;font-size:13px;">Location: <strong>${escapeHtml(location)}</strong></p>
          <p style="margin:0 0 18px;font-size:13px;">Address Details: <strong>${escapeHtml(order.addressDetails)}</strong></p>
          <a href="${escapeHtml(SITE_URL)}" style="display:inline-block;padding:10px 14px;background:#ea580c;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;">Open Flex Fits Dashboard</a>
        </div>
      </div>
    </div>
  `;
}

async function getItemsWithProductImages(orderItems: Array<{ productId: string; productName: string; quantity: number; size: string; price: number }>): Promise<EmailOrderItem[]> {
  const baseItems: EmailOrderItem[] = orderItems.map((item) => ({
    productId: item.productId,
    productName: item.productName,
    quantity: Math.max(0, Number(item.quantity || 0)),
    size: String(item.size || ''),
    price: Math.max(0, Number(item.price || 0)),
  }));

  if (!supabase || baseItems.length === 0) return baseItems;

  const ids = Array.from(new Set(baseItems.map((item) => String(item.productId || '').trim()).filter(Boolean)));
  if (ids.length === 0) return baseItems;

  const { data, error } = await supabase
    .from('products')
    .select('Product_ID,Pictures')
    .in('Product_ID', ids);

  if (error) {
    console.warn('Unable to fetch product images for email payload:', error.message);
    return baseItems;
  }

  const imageById = new Map<string, string>();
  for (const row of data || []) {
    const id = String((row as any).Product_ID || '').trim();
    const image = String((row as any).Pictures || '').trim();
    if (id && image) imageById.set(id, image);
  }

  return baseItems.map((item) => ({
    ...item,
    image: imageById.get(String(item.productId || '').trim()) || undefined,
  }));
}

async function sendEmailEvent(payload: {
  event: 'order_created_admin' | 'order_received_customer' | 'order_dispatched_customer';
  toEmail: string;
  subject: string;
  html: string;
  order: Order;
  items: EmailOrderItem[];
}): Promise<void> {
  const attemptId = `mail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (!EMAIL_WEBHOOK_URL) {
    pushEmailLog({
      id: attemptId,
      ts: new Date().toISOString(),
      event: payload.event,
      toEmail: payload.toEmail,
      subject: payload.subject,
      orderId: payload.order.id,
      status: 'failed',
      stage: 'primary',
      detail: 'Webhook URL is missing (VITE_EMAIL_WEBHOOK_URL).',
    });
    return;
  }

  const requestPayload = {
    secret: EMAIL_WEBHOOK_SECRET,
    event: payload.event,
    toEmail: payload.toEmail,
    subject: payload.subject,
    html: payload.html,
    siteUrl: SITE_URL,
    adminEmail: ADMIN_NOTIFICATION_EMAIL,
    order: payload.order,
    items: payload.items,
  };

  const formBody = new URLSearchParams({
    secret: String(requestPayload.secret || ''),
    event: String(requestPayload.event || ''),
    toEmail: String(requestPayload.toEmail || ''),
    subject: String(requestPayload.subject || ''),
    html: String(requestPayload.html || ''),
    siteUrl: String(requestPayload.siteUrl || ''),
    adminEmail: String(requestPayload.adminEmail || ''),
    order: JSON.stringify(requestPayload.order || {}),
    items: JSON.stringify(requestPayload.items || []),
  });

  try {
    const response = await fetch(EMAIL_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: formBody.toString(),
    });

    const bodyText = await response.text();

    if (!response.ok) {
      throw new Error(`Form webhook responded ${response.status}: ${redactSensitiveText(bodyText).slice(0, 240)}`);
    }

    const classified = classifyWebhookResponse(bodyText);
    if (!classified.success) {
      throw new Error(classified.detail);
    }

    pushEmailLog({
      id: attemptId,
      ts: new Date().toISOString(),
      event: payload.event,
      toEmail: payload.toEmail,
      subject: payload.subject,
      orderId: payload.order.id,
      status: 'success',
      stage: 'primary',
      detail: classified.detail,
    });
  } catch (error) {
    const formError = redactSensitiveText(error instanceof Error ? error.message : String(error));

    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const beaconPayload = JSON.stringify(requestPayload);
        const beaconBlob = new Blob([beaconPayload], { type: 'text/plain;charset=utf-8' });
        const queued = navigator.sendBeacon(EMAIL_WEBHOOK_URL, beaconBlob);

        if (queued) {
          pushEmailLog({
            id: attemptId,
            ts: new Date().toISOString(),
            event: payload.event,
            toEmail: payload.toEmail,
            subject: payload.subject,
            orderId: payload.order.id,
            status: 'fallback-unknown',
            stage: 'fallback',
            detail: `Form request failed (${formError}); sendBeacon fallback queued (delivery cannot be verified by browser).`,
          });
          return;
        }
      }
    } catch {
      // Ignore beacon errors and continue to final fetch fallback.
    }

    try {
      // no-cors is opaque; request may still succeed when strict CORS blocks readable responses.
      await fetch(EMAIL_WEBHOOK_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(requestPayload),
      });

      pushEmailLog({
        id: attemptId,
        ts: new Date().toISOString(),
        event: payload.event,
        toEmail: payload.toEmail,
        subject: payload.subject,
        orderId: payload.order.id,
        status: 'fallback-unknown',
        stage: 'fallback',
        detail: `Form request failed (${formError}); no-cors fallback sent (delivery cannot be verified by browser).`,
      });
    } catch (fallbackError) {
      const noCorsError = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      pushEmailLog({
        id: attemptId,
        ts: new Date().toISOString(),
        event: payload.event,
        toEmail: payload.toEmail,
        subject: payload.subject,
        orderId: payload.order.id,
        status: 'failed',
        stage: 'fallback',
        detail: `Form request failed (${formError}); no-cors fallback failed (${noCorsError}).`,
      });
    }
  }
}

async function notifyAdminOrderCreated(order: Order): Promise<void> {
  const items = await getItemsWithProductImages(order.items || []);
  const html = buildOrderEmailHtml(
    order,
    items,
    'New Order Created',
    'A new order was placed on Flex Fits. Review and dispatch it from the admin panel.'
  );

  await sendEmailEvent({
    event: 'order_created_admin',
    toEmail: ADMIN_NOTIFICATION_EMAIL,
    subject: `New Order ${order.id} - ${order.customerName}`,
    html,
    order,
    items,
  });
}

async function notifyCustomerOrderDispatched(order: Order): Promise<void> {
  if (!order.customerEmail) return;

  const items = await getItemsWithProductImages(order.items || []);
  const html = buildOrderEmailHtml(
    order,
    items,
    'Order Confirmation - Accepted and Dispatched',
    'Your order has been accepted and dispatched by Flex Fits. Thank you for your trust.'
  );

  await sendEmailEvent({
    event: 'order_dispatched_customer',
    toEmail: order.customerEmail,
    subject: `Your Flex Fits Order ${order.id} is Confirmed`,
    html,
    order,
    items,
  });
}

async function notifyCustomerOrderReceived(order: Order): Promise<void> {
  if (!order.customerEmail) return;

  const items = await getItemsWithProductImages(order.items || []);
  const html = buildOrderEmailHtml(
    order,
    items,
    'Order Received - Processing Started',
    'We received your order and started preparing it. You will receive another email once your order is accepted and dispatched.'
  );

  await sendEmailEvent({
    event: 'order_received_customer',
    toEmail: order.customerEmail,
    subject: `We received your Flex Fits order ${order.id}`,
    html,
    order,
    items,
  });
}

function randomSessionToken(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getReservationSessionId(): string {
  try {
    const existing = String(localStorage.getItem(RESERVATION_SESSION_STORAGE_KEY) || '').trim();
    if (existing) return existing;
    const created = randomSessionToken();
    localStorage.setItem(RESERVATION_SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return randomSessionToken();
  }
}

function readLocalReservations(): StockReservation[] {
  try {
    const raw = localStorage.getItem(LOCAL_RESERVATION_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalReservations(rows: StockReservation[]): void {
  try {
    localStorage.setItem(LOCAL_RESERVATION_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Ignore localStorage failures silently.
  }
}

export async function cleanupExpiredReservations(): Promise<number> {
  if (!supabase) {
    const nowMs = Date.now();
    const reservations = readLocalReservations();
    let released = 0;
    const updated = reservations.map((row) => {
      if (row.status === 'active' && new Date(row.expiresAt).getTime() <= nowMs) {
        released += 1;
        return { ...row, status: 'released', releasedAt: new Date().toISOString() } as any;
      }
      return row;
    });
    writeLocalReservations(updated);
    return released;
  }

  try {
    const { data, error } = await supabase.rpc('cleanup_expired_stock_reservations');
    if (error) throw error;
    return Math.max(0, Number(data || 0));
  } catch (error) {
    console.warn('Unable to cleanup expired reservations:', error);
    return 0;
  }
}

export async function getSessionActiveReservations(sessionId: string = getReservationSessionId()): Promise<StockReservation[]> {
  if (!supabase) {
    const nowMs = Date.now();
    const reservations = readLocalReservations();
    return reservations.filter((row) => row.sessionId === sessionId && row.status === 'active' && new Date(row.expiresAt).getTime() > nowMs);
  }

  await cleanupExpiredReservations();
  const { data, error } = await supabase
    .from('stock_reservations')
    .select('*')
    .eq('session_id', sessionId)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString());

  if (error) throw error;

  return (data || []).map((row: any) => ({
    id: String(row.id),
    productId: String(row.product_id || ''),
    size: String(row.size || ''),
    quantity: Math.max(0, Number(row.quantity || 0)),
    sessionId: String(row.session_id || ''),
    status: String(row.status || 'active') as StockReservation['status'],
    reservedAt: String(row.reserved_at || row.created_at || ''),
    expiresAt: String(row.expires_at || ''),
    orderId: row.order_id ? String(row.order_id) : null,
  }));
}

export async function reserveCartLine(payload: {
  productId: string;
  size: string;
  quantity: number;
  existingReservationId?: string;
  sessionId?: string;
}): Promise<{ ok: boolean; message: string; reservationId?: string; expiresAt?: string; availableAfter?: number }> {
  const sessionId = payload.sessionId || getReservationSessionId();
  const quantity = Math.max(1, Number(payload.quantity || 1));

  if (!supabase) {
    const now = new Date();
    const expires = new Date(now.getTime() + RESERVATION_TTL_SECONDS * 1000);
    const reservations = readLocalReservations();
    const existingIndex = payload.existingReservationId
      ? reservations.findIndex((row) => row.id === payload.existingReservationId && row.sessionId === sessionId && row.status === 'active')
      : -1;

    const activeForProduct = reservations
      .filter((row) => row.productId === payload.productId && row.status === 'active' && new Date(row.expiresAt).getTime() > now.getTime())
      .reduce((sum, row) => sum + Math.max(0, Number(row.quantity || 0)), 0);

    const savedProducts = localStorage.getItem('flex_products');
    const products = savedProducts ? JSON.parse(savedProducts) : [];
    const product = (products || []).find((p: Product) => p.Product_ID === payload.productId);
    const baseStock = Math.max(0, Number((product as any)?.pieces || 0));
    const currentExistingQty = existingIndex >= 0 ? Math.max(0, Number(reservations[existingIndex].quantity || 0)) : 0;
    const reservedOthers = Math.max(0, activeForProduct - currentExistingQty);
    if (baseStock - reservedOthers < quantity) {
      return { ok: false, message: 'Reserved by another shopper. Please reduce quantity.', availableAfter: Math.max(0, baseStock - reservedOthers) };
    }

    if (existingIndex >= 0) {
      const nextQty = currentExistingQty + quantity;
      reservations[existingIndex] = {
        ...reservations[existingIndex],
        quantity: nextQty,
        size: payload.size,
        reservedAt: now.toISOString(),
        expiresAt: expires.toISOString(),
        status: 'active',
      };
      writeLocalReservations(reservations);
      return {
        ok: true,
        message: 'Reserved successfully.',
        reservationId: reservations[existingIndex].id,
        expiresAt: reservations[existingIndex].expiresAt,
        availableAfter: Math.max(0, baseStock - reservedOthers - nextQty),
      };
    }

    const localReservation: StockReservation = {
      id: `local-res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      productId: payload.productId,
      size: payload.size,
      quantity,
      sessionId,
      status: 'active',
      reservedAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      orderId: null,
    };
    reservations.unshift(localReservation);
    writeLocalReservations(reservations);
    return {
      ok: true,
      message: 'Reserved successfully.',
      reservationId: localReservation.id,
      expiresAt: localReservation.expiresAt,
      availableAfter: Math.max(0, baseStock - reservedOthers - quantity),
    };
  }

  const { data, error } = await supabase.rpc('reserve_product_stock_fcfs', {
    p_session_id: sessionId,
    p_product_id: payload.productId,
    p_size: payload.size,
    p_quantity: quantity,
    p_ttl_seconds: RESERVATION_TTL_SECONDS,
    p_existing_reservation_id: payload.existingReservationId || null,
  });

  if (error) {
    console.error('reserve_product_stock_fcfs error:', error);
    return { ok: false, message: 'Unable to reserve stock right now. Please retry.' };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, message: 'No reservation result received.' };

  return {
    ok: Boolean(row.ok),
    message: String(row.message || (row.ok ? 'Reserved successfully.' : 'Reservation failed.')),
    reservationId: row.reservation_id ? String(row.reservation_id) : undefined,
    expiresAt: row.expires_at ? String(row.expires_at) : undefined,
    availableAfter: row.available_after !== undefined && row.available_after !== null ? Math.max(0, Number(row.available_after)) : undefined,
  };
}

export async function releaseCartLineReservation(reservationId?: string, sessionId: string = getReservationSessionId()): Promise<boolean> {
  if (!reservationId) return false;

  if (!supabase) {
    const nowIso = new Date().toISOString();
    const rows = readLocalReservations();
    const next = rows.map((row) => {
      if (row.id === reservationId && row.sessionId === sessionId && row.status === 'active') {
        return { ...row, status: 'released', releasedAt: nowIso } as any;
      }
      return row;
    });
    writeLocalReservations(next);
    return true;
  }

  const { data, error } = await supabase.rpc('release_stock_reservation', {
    p_session_id: sessionId,
    p_reservation_id: reservationId,
  });

  if (error) {
    console.warn('release_stock_reservation error:', error);
    return false;
  }

  return Boolean(data);
}

export async function extendExpiredReservation(reservationId: string, sessionId: string = getReservationSessionId(), extendSeconds = 120): Promise<{ ok: boolean; message: string; expiresAt?: string }> {
  if (!supabase) {
    const now = Date.now();
    const rows = readLocalReservations();
    const index = rows.findIndex((row) => row.id === reservationId && row.sessionId === sessionId && row.status === 'active');
    if (index < 0) return { ok: false, message: 'Reservation cannot be extended.' };
    const currentExp = new Date(rows[index].expiresAt).getTime();
    if (currentExp > now || currentExp < now - 120000) {
      return { ok: false, message: 'Reservation cannot be extended.' };
    }
    const exp = new Date(now + Math.max(30, extendSeconds) * 1000).toISOString();
    rows[index] = { ...rows[index], expiresAt: exp };
    writeLocalReservations(rows);
    return { ok: true, message: 'Reservation extended.', expiresAt: exp };
  }

  const { data, error } = await supabase.rpc('extend_stock_reservation', {
    p_session_id: sessionId,
    p_reservation_id: reservationId,
    p_extend_seconds: extendSeconds,
  });

  if (error) {
    console.warn('extend_stock_reservation error:', error);
    return { ok: false, message: 'Reservation cannot be extended.' };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, message: 'Reservation cannot be extended.' };
  return {
    ok: Boolean(row.ok),
    message: String(row.message || ''),
    expiresAt: row.expires_at ? String(row.expires_at) : undefined,
  };
}

export async function commitCheckoutReservations(orderId: string, reservationIds: string[], sessionId: string = getReservationSessionId()): Promise<void> {
  const ids = reservationIds.map((v) => String(v || '').trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error('Some items in your cart have expired.');
  }

  if (!supabase) {
    const nowIso = new Date().toISOString();
    const rows = readLocalReservations();
    const updated = rows.map((row) => {
      if (ids.includes(row.id) && row.sessionId === sessionId && row.status === 'active' && new Date(row.expiresAt).getTime() > Date.now()) {
        return { ...row, status: 'confirmed', orderId, confirmedAt: nowIso } as any;
      }
      return row;
    });
    writeLocalReservations(updated);
    return;
  }

  const { data, error } = await supabase.rpc('commit_checkout_reservations', {
    p_session_id: sessionId,
    p_order_id: orderId,
    p_reservation_ids: ids,
  });

  if (error) {
    console.error('commit_checkout_reservations error:', error);
    throw new Error('Some items in your cart have expired.');
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.ok) {
    throw new Error(String(row?.message || 'Some items in your cart have expired.'));
  }
}

// ==================== PRODUCTS ====================

function toNumberOrNull(value: any): number | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().replace(/,/g, '');
  if (normalized === '') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Normalize colors from DB row (text[], legacy text, or comma-separated). */
export function normalizeColorsFromRow(p: any): string[] {
  const tokens: string[] = [];
  const push = (s: string) => {
    const t = String(s || '').trim().toLowerCase();
    if (t) tokens.push(t);
  };
  const rawArr = p.colors ?? p.Colors;
  if (Array.isArray(rawArr)) {
    for (const c of rawArr) push(String(c));
  }
  const legacy = p.color ?? p.Color ?? p.Colour ?? p.colour;
  if (typeof legacy === 'string' && legacy.trim()) {
    for (const part of legacy.split(',')) push(part);
  }
  return Array.from(new Set(tokens));
}

/** Tokens for filters / UI (works for Product from API or legacy `color` string). */
export function getProductColorTokens(product: Product): string[] {
  return normalizeColorsFromRow(product as any);
}

function normalizeImageListFromRow(p: any): string[] {
  const values: string[] = [];
  const push = (value: any) => {
    const token = normalizeImageSourceToken(value);
    if (token) values.push(token);
  };

  const rawImages = p.images ?? p.Images ?? p.pictures ?? p.Pictures;
  if (Array.isArray(rawImages)) {
    for (const image of rawImages) push(image);
  } else if (typeof rawImages === 'string' && rawImages.trim()) {
    const raw = rawImages.trim();
    if (/^data:image\//i.test(raw)) {
      // A data URL contains a required comma; splitting would corrupt it.
      push(raw);
    } else {
      for (const image of raw.split(',')) push(image);
    }
  }

  if (values.length === 0) {
    push(p.image ?? p.Image ?? p.picture ?? p.Picture);
  }

  return Array.from(new Set(values));
}

function normalizeSizeStockFromRow(p: any): ProductSizeStock[] {
  const raw = p.size_stock ?? p.sizeStock ?? p.sizes_stock ?? p.Size_Stock;
  const parsed: any[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' && raw.trim()
      ? (() => {
          try {
            const json = JSON.parse(raw);
            return Array.isArray(json) ? json : [];
          } catch {
            return [];
          }
        })()
      : [];

  return parsed
    .map((entry) => ({
      size: String(entry?.size ?? entry?.Size ?? entry?.label ?? '').trim(),
      stock: Math.max(0, Math.floor(Number(entry?.stock ?? entry?.Stock ?? 0))),
    }))
    .filter((entry) => entry.size);
}

function mapProductRowToAppProduct(p: any): Product {
  const colors = normalizeColorsFromRow(p);
  const images = normalizeImageListFromRow(p);
  const sizeStock = normalizeSizeStockFromRow(p);
  const sizes = sizeStock.length > 0
    ? sizeStock.map((entry) => entry.size)
    : (p.SIZE ? String(p.SIZE).split(',').map((s: string) => s.trim()).filter(Boolean) : []) || p.sizes || [];
  return {
    Product_ID: p.Product_ID,
    brandName: p.Name_of_Brand || p.name_of_brand || '',
    productName: p.Name_of_Product || p.Name_Product || p.name_of_product || p.Name_of_Item || p.name_of_item || '',
    gender: inferGenderFromRow(p),
    name: [
      p.Name_of_Brand || p.name_of_brand || '',
      p.Name_of_Product || p.Name_Product || p.name_of_product || p.Name_of_Item || p.name_of_item || ''
    ].filter(Boolean).join(' - ') || p.name || '',
    category: p.Category || p.category,
    type: p.Type || p.type,
    price: toNumberOrNull(p.Price ?? p.price) ?? 0,
    cost: toNumberOrNull(p.Cost ?? p.cost) ?? 0,
    initialStock: Math.max(0, toNumberOrNull(p.Stock ?? p.stock ?? p.initial_stock) ?? 0),
    pieces: Math.max(0, toNumberOrNull(p.Items_LEFT_in_stock ?? p.items_left_in_stock ?? p.pieces) ?? toNumberOrNull(p.Stock ?? p.stock ?? p.initial_stock) ?? 0),
    sold: Math.max(0, toNumberOrNull(p.Items_Sold ?? p.items_sold ?? p.sold) ?? 0),
    sizes,
    sizeStock,
    description: p.Description || p.description || '',
    image: normalizeProductImage(images[0] || p.Pictures || p.pictures || p.picture || p.image),
    images,
    isAuthentic: p.is_authentic ?? true,
    status: p.Status || p.status,
    originalPrice: toNumberOrNull(p.original_price ?? p.Original_Price ?? p.originalPrice),
    onSale: Boolean(p.on_sale ?? p.On_Sale ?? p.onSale),
    colors,
    color: colors.length ? colors.join(', ') : undefined,
  };
}

async function subtractActiveReservationsFromProducts(products: Product[]): Promise<void> {
  if (!supabase || products.length === 0) return;
  try {
    const { data: reservationRows } = await supabase
      .from('stock_reservations')
      .select('product_id,quantity')
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString());

    const reservedByProduct = new Map<string, number>();
    for (const row of reservationRows || []) {
      const productId = String((row as any).product_id || '').trim();
      const qty = Math.max(0, Number((row as any).quantity || 0));
      if (!productId || qty <= 0) continue;
      reservedByProduct.set(productId, (reservedByProduct.get(productId) || 0) + qty);
    }

    for (const product of products) {
      const reserved = Math.max(0, reservedByProduct.get(String(product.Product_ID || '').trim()) || 0);
      product.pieces = Math.max(0, Number(product.pieces || 0) - reserved);
    }
  } catch {
    // Keep product list available even if reservation table is not migrated yet.
  }
}

export async function getProducts(): Promise<Product[]> {
  if (!supabase) {
    // Fallback to localStorage if Supabase not configured
    const saved = localStorage.getItem('flex_products');
    return saved ? JSON.parse(saved) : [];
  }

  try {
    const { data, error } = await supabase
      .from('products')
      .select('*');

    if (error) throw error;

    const transformed = (data || []).map((p: any) => mapProductRowToAppProduct(p));

    await subtractActiveReservationsFromProducts(transformed);

    // Keep fallback cache aligned with database to avoid stale rollback on refresh.
    localStorage.setItem('flex_products', JSON.stringify(transformed));
    return transformed;
  } catch (error) {
    console.error('Error fetching products:', error);
    // Fallback to localStorage
    const saved = localStorage.getItem('flex_products');
    return saved ? JSON.parse(saved) : [];
  }
}

export async function saveProduct(product: Product): Promise<void> {
  if (!supabase) {
    // Fallback to localStorage
    const saved = localStorage.getItem('flex_products');
    const products = saved ? JSON.parse(saved) : [];
    const existing = products.findIndex((p: Product) => p.Product_ID === product.Product_ID);
    if (existing >= 0) {
      products[existing] = product;
    } else {
      products.unshift(product);
    }
    localStorage.setItem('flex_products', JSON.stringify(products));
    return;
  }

  try {
    // Debug: Log the product payload before any DB operation
    console.log('[saveProduct] Attempting to save product:', JSON.stringify(product, null, 2));
    let colors: string[] = [];
    if (Array.isArray(product.colors) && product.colors.length > 0) {
      colors = Array.from(
        new Set(product.colors.map((c: string) => String(c).trim().toLowerCase()).filter(Boolean))
      );
    } else if (typeof product.color === 'string' && product.color.trim()) {
      colors = product.color.split(',').map((c: string) => c.trim().toLowerCase()).filter(Boolean);
    }
    // Debug: Log normalized colors
    console.log('[saveProduct] Normalized colors:', colors);

    // Do not send `colors` in upsert: mixed case / cache issues can fail the whole row.
    // Persist colors in a follow-up PATCH (tries array + legacy text column names).
    const productId = String(product.Product_ID || '').trim();
    if (!productId) {
      console.error('[saveProduct] Product_ID is missing or empty. Aborting save.');
      throw new Error('Product_ID is required to save a product.');
    }

    // Validate stock and items_sold
    const stock = Math.floor(Number(product.initialStock));
    const itemsSold = Math.floor(Number(product.sold));
    if (
      !Number.isInteger(stock) ||
      !Number.isInteger(itemsSold) ||
      stock < 0 ||
      itemsSold < 0 ||
      itemsSold > stock
    ) {
      throw new Error('Invalid stock values: stock and items_sold must be integers, >= 0, and items_sold <= stock.');
    }

    // ENFORCE SYSTEM INVARIANT (Backend calculation is source of truth)
    const computedPieces = stock - itemsSold;
    product.initialStock = stock;
    product.sold = itemsSold;
    product.pieces = computedPieces;

    const basePayload: Record<string, unknown> = {
      Product_ID: productId,
      Name_of_Brand: product.brandName || product.name,
      Name_of_Product: product.productName || product.name,
      Category: product.category,
      Type: product.type,
      Price: product.price,
      Cost: product.cost,
      Stock: stock,
      Items_Sold: itemsSold,
      SIZE: product.sizes.join(','),
      Status: product.status || 'Active',
      Pictures: product.images?.[0] || product.image,
      images: product.images && product.images.length > 0 ? product.images : [product.image].filter(Boolean),
      Description: product.description,
      colors: colors,
      size_stock: Array.isArray(product.sizeStock) ? product.sizeStock : [],
      original_price: product.originalPrice ?? null,
      on_sale: Boolean(product.onSale),
    };
    // Debug: Log the basePayload that will be sent to Supabase
    console.log('[saveProduct] basePayload for DB (colors included):', JSON.stringify(basePayload, null, 2));

    const isMissingSchemaColumn = (
      err: { message?: string; details?: string; hint?: string; code?: string } | null,
      columnName: string
    ) => {
      if (!err) return false;
      const raw = `${err.message || ''} ${err.details || ''} ${err.hint || ''}`;
      const t = raw.toLowerCase();
      const col = columnName.toLowerCase();
      // Avoid matching `id` inside `product_id` / `Product_ID` (t.includes('id') is a false positive).
      const colReferenced =
        col === 'id'
          ? /['"]id['"]/.test(raw) || /\bthe\s+['"]id['"]\s+column\b/i.test(raw) || /\bcolumn\s+['"]id['"]\s+of\b/i.test(raw)
          : t.includes(col) || raw.toLowerCase().includes(`'${col}'`);
      return (
        colReferenced &&
        (t.includes('column') || t.includes('schema cache') || err.code === 'PGRST204')
      );
    };

    /** PostgREST 400: no UNIQUE constraint / wrong onConflict target (e.g. only PK is `id`). */
    const isOnConflictTargetError = (err: { message?: string; details?: string; hint?: string } | null) => {
      if (!err) return false;
      const t = `${err.message || ''} ${err.details || ''} ${err.hint || ''}`.toLowerCase();
      return (
        t.includes('no unique') ||
        t.includes('unique constraint') ||
        t.includes('exclusion constraint matching') ||
        t.includes('on conflict') ||
        t.includes('42p10')
      );
    };

    const requestedGender = normalizeGender(product.gender);
    const db = supabase;

    const omitUndefined = (row: Record<string, unknown>): Record<string, unknown> => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (v !== undefined) o[k] = v;
      }
      return o;
    };

    /**
     * Second attempt when Pascal CSV keys fail: keep the same column names as `basePayload` (Category, Type, …).
     * True snake_case keys like `category` break PostgREST when the table only has quoted `"Category"` (PGRST204).
     * Only swap the business key to `product_id` for tables that use snake_case there.
     */
    const buildRowWithSnakeProductIdOnly = (): Record<string, unknown> => {
      const row: Record<string, unknown> = { ...basePayload, Gender: requestedGender };
      delete row.Product_ID;
      row.product_id = productId;
      return row;
    };

    const isUnknownJsonKeyError = (err: { message?: string; details?: string; code?: string } | null) => {
      if (!err) return false;
      const t = `${err.message || ''} ${err.details || ''}`.toLowerCase();
      return (
        err.code === 'PGRST204' ||
        (t.includes('column') &&
          (t.includes('schema cache') || t.includes('could not find') || t.includes('unknown')))
      );
    };

    /** Insert or update by business product key without `upsert` / `on_conflict` (avoids PostgREST `id` / cache issues). */
    const persistByProductId = async (row: Record<string, unknown>) => {
      const cleanNoId: Record<string, unknown> = omitUndefined({ ...row });
      delete cleanNoId.id;

      const insertNeedsPkId = (err: { message?: string; details?: string; code?: string } | null) => {
        if (!err) return false;
        if (err.code === '23502') return true;
        const t = `${err.message || ''} ${err.details || ''}`.toLowerCase();
        return (
          (t.includes('null value') && /['"]id['"]/.test(t) && (t.includes('not null') || t.includes('not-null'))) ||
          (t.includes('violates not-null constraint') && /['"]id['"]/.test(t))
        );
      };

      for (const key of ['Product_ID', 'product_id'] as const) {
        const { data: existing, error: selErr } = await db
          .from('products')
          .select(key)
          .eq(key, productId)
          .maybeSingle();

        if (selErr) {
          if (key === 'Product_ID' && isMissingSchemaColumn(selErr, 'Product_ID')) continue;
          if (key === 'product_id' && isMissingSchemaColumn(selErr, 'product_id')) continue;
          return { error: selErr };
        }

        if (existing) {
          return db.from('products').update(cleanNoId).eq(key, productId);
        }

        let ins = await db.from('products').insert(cleanNoId);
        if (!ins.error) return ins;
        if (ins.error.code === '23505') {
          return db.from('products').update(cleanNoId).eq(key, productId);
        }
        if (insertNeedsPkId(ins.error)) {
          const withPkId = { ...cleanNoId, id: productId };
          ins = await db.from('products').insert(withPkId);
          if (!ins.error) return ins;
          if (ins.error.code === '23505') {
            return db.from('products').update(withPkId).eq(key, productId);
          }
        }
        if (key === 'Product_ID') continue;
        return ins;
      }

      return {
        error: {
          message:
            'Could not resolve products row by Product_ID or product_id (check column names and RLS SELECT).',
          code: 'PGRST-flexfits',
        } as any,
      };
    };

    const upsertTry = async (payload: Record<string, unknown>, onConflict: string) =>
      db.from('products').upsert(payload, { onConflict });

    const withIdPk = { id: productId, ...basePayload };
    let upsertPayload: Record<string, unknown> = { ...basePayload, Gender: requestedGender };
    let { error } = await persistByProductId(upsertPayload);
    if (error) {
      console.error('[saveProduct] persistByProductId error:', error);
    } else {
      console.log('[saveProduct] persistByProductId success');
    }

    if (error && isUnknownJsonKeyError(error)) {
      upsertPayload = buildRowWithSnakeProductIdOnly();
      ({ error } = await persistByProductId(upsertPayload));
      if (error) {
        console.error('[saveProduct] persistByProductId (snake_case) error:', error);
      } else {
        console.log('[saveProduct] persistByProductId (snake_case) success');
      }
    }

    /** Multi-shape writes when Product_ID-only `select` paths failed or JSON keys mismatch. */
    const persistByLegacyPk = async () => {
      const name =
        [product.brandName, product.productName].filter(Boolean).join(' - ') ||
        product.name ||
        '';
      const rowLower: Record<string, unknown> = {
        id: productId,
        name,
        gender: requestedGender,
        category: product.category,
        type: product.type,
        price: product.price,
        cost: product.cost,
        initial_stock: product.initialStock,
        pieces: product.pieces,
        sold: product.sold,
        sizes: Array.isArray(product.sizes) && product.sizes.length > 0 ? product.sizes : [],
        description: product.description || '',
        image: product.image || '',
        is_authentic: product.isAuthentic ?? true,
      };
      const rowPascal: Record<string, unknown> = {
        id: productId,
        name,
        Gender: requestedGender,
        Category: product.category,
        Type: product.type,
        Price: product.price,
        Cost: product.cost,
        initial_stock: product.initialStock,
        pieces: product.pieces,
        sold: product.sold,
        sizes: Array.isArray(product.sizes) && product.sizes.length > 0 ? product.sizes : [],
        Description: product.description || '',
        image: product.image || '',
        is_authentic: product.isAuthentic ?? true,
      };
      const rowFullCsv: Record<string, unknown> = {
        id: productId,
        ...basePayload,
        Gender: requestedGender,
      };
      const rowCsvNoId: Record<string, unknown> = { ...basePayload, Gender: requestedGender };

      let eqKey: 'Product_ID' | 'product_id' | null = null;
      for (const key of ['Product_ID', 'product_id'] as const) {
        const { data: ex, error: selErr } = await db
          .from('products')
          .select(key)
          .eq(key, productId)
          .maybeSingle();
        if (selErr) {
          if (isMissingSchemaColumn(selErr, key)) continue;
          return { error: selErr };
        }
        if (ex) {
          eqKey = key;
          break;
        }
      }

      const tryWrite = async (r: Record<string, unknown>) => {
        const body = omitUndefined({ ...r });
        if (eqKey) {
          return db.from('products').update(body).eq(eqKey, productId);
        }
        const ins = await db.from('products').insert(body);
        if (ins.error?.code === '23505') {
          for (const k of ['Product_ID', 'product_id'] as const) {
            const u = await db.from('products').update(body).eq(k, productId);
            if (!u.error) return u;
            if (!isMissingSchemaColumn(u.error, k)) break;
          }
        }
        return ins;
      };

      const variants = [rowFullCsv, rowPascal, rowLower, rowCsvNoId];
      let out = await tryWrite(variants[0]);
      for (let i = 1; i < variants.length; i++) {
        if (!out.error || !isUnknownJsonKeyError(out.error)) break;
        out = await tryWrite(variants[i]);
      }
      return out;
    };

    if (
      error &&
      (error.code === 'PGRST-flexfits' ||
        String(error.message || '').includes('Could not resolve products row') ||
        isUnknownJsonKeyError(error))
    ) {
      ({ error } = await persistByLegacyPk());
      if (error) {
        console.error('[saveProduct] persistByLegacyPk error:', error);
      } else {
        console.log('[saveProduct] persistByLegacyPk success');
      }
    }

    const insertLikelyNeedsIdColumn = (err: typeof error) => {
      // id column is not used in this schema anymore
      return false;
    };

    const shouldTryIdKeyUpsert = (err: typeof error) =>
      !!err &&
      (isOnConflictTargetError(err) ||
        isMissingSchemaColumn(err, 'Product_ID') ||
        isMissingSchemaColumn(err, 'product_id'));

    if (error && shouldTryIdKeyUpsert(error)) {
      // Do not attempt upsert with 'id' as conflict target; this column does not exist.
      // Only try with Product_ID or product_id as conflict targets if needed.
      // If you reach here, the schema is not compatible.
      console.error('[saveProduct] Schema is not compatible: products.id does not exist.');
      throw new Error('Product upsert failed: products.id does not exist. Please ensure all code and schema use Product_ID as the key.');
    }

    if (error && isMissingSchemaColumn(error, 'gender')) {
      upsertPayload = { ...basePayload };
      ({ error } = await persistByProductId(upsertPayload));
      if (error) {
        console.error('[saveProduct] persistByProductId (no gender) error:', error);
      } else {
        console.log('[saveProduct] persistByProductId (no gender) success');
      }
    }

    if (error && isMissingSchemaColumn(error, 'gender')) {
      upsertPayload = { ...withIdPk };
      ({ error } = await upsertTry(upsertPayload, 'id'));
      if (error) {
        console.error('[saveProduct] upsertTry (id) error:', error);
      } else {
        console.log('[saveProduct] upsertTry (id) success');
      }
      if (error && isMissingSchemaColumn(error, 'id')) {
        upsertPayload = { ...basePayload };
        ({ error } = await persistByProductId(upsertPayload));
        if (error) {
          console.error('[saveProduct] persistByProductId (after id) error:', error);
        } else {
          console.log('[saveProduct] persistByProductId (after id) success');
        }
      }
    }

    if (error && (isOnConflictTargetError(error) || isMissingSchemaColumn(error, 'id'))) {
      upsertPayload = { ...basePayload, Gender: requestedGender };
      ({ error } = await persistByProductId(upsertPayload));
      if (error) {
        console.error('[saveProduct] persistByProductId (onConflict/id) error:', error);
      } else {
        console.log('[saveProduct] persistByProductId (onConflict/id) success');
      }
    }

    if (error && isMissingSchemaColumn(error, 'gender')) {
      upsertPayload = { ...basePayload };
      ({ error } = await persistByProductId(upsertPayload));
      if (error) {
        console.error('[saveProduct] persistByProductId (final no gender) error:', error);
      } else {
        console.log('[saveProduct] persistByProductId (final no gender) success');
      }
    }

    if (error) {
      console.error('[saveProduct] FINAL ERROR:', error);
      console.error('[saveProduct] FINAL PAYLOAD:', JSON.stringify(upsertPayload, null, 2));
      console.error('[saveProduct] ORIGINAL PRODUCT:', JSON.stringify(product, null, 2));
      const detail = [error.message, error.details, error.hint].filter(Boolean).join(' | ');
      throw new Error(
        detail ||
          'Product upsert failed. Typical fixes: UNIQUE("Product_ID") or PK id + upsert; extend category CHECK for Underwear; reload PostgREST schema cache.'
      );
    }

    // Colors are now saved as part of the main payload above.
    // No follow-up PATCH needed.
    console.log('[saveProduct] Product saved successfully with colors:', colors);
  } catch (error) {
    console.error('Error saving product (full):', error);
    throw error;
  }
}

/** Products whose `colors` array contains ALL of the selected tokens (AND). Uses PostgREST `cs`. */
export async function filterProductsByColors(selectedColors: string[]): Promise<Product[]> {
  const normalized = Array.from(
    new Set(selectedColors.map((c) => String(c).trim().toLowerCase()).filter(Boolean))
  );
  if (!supabase) {
    const all = await getProducts();
    return all.filter((p) => {
      const list = normalizeColorsFromRow(p);
      return normalized.length > 0 && normalized.every((c) => list.includes(c));
    });
  }
  if (!normalized.length) return getProducts();

  const { data, error } = await supabase
    .from('products')
    .select('*')
    .contains('colors', normalized);

  if (error) throw error;

  const transformed = (data || []).map((p: any) => mapProductRowToAppProduct(p));
  await subtractActiveReservationsFromProducts(transformed);
  return transformed;
}

/**
 * Admin: set sellable quantity shown to customers (`nextDisplayedPieces` matches `getProducts()` pieces
 * after reservation subtraction). Persists `Items_LEFT_in_stock` = displayed + active reservation qty.
 */
export async function patchProductStockLevels(productId: string, nextDisplayedPieces: number): Promise<void> {
  const clamped = Math.max(0, Math.floor(Number(nextDisplayedPieces)));
  if (!supabase) {
    const saved = localStorage.getItem('flex_products');
    const products: Product[] = saved ? JSON.parse(saved) : [];
    const i = products.findIndex((p) => p.Product_ID === productId);
    if (i >= 0) {
      products[i] = { ...products[i], pieces: clamped };
      localStorage.setItem('flex_products', JSON.stringify(products));
    }
    return;
  }

  // This function is now deprecated: items_left_in_stock is generated, so only stock/items_sold should be updated by admin UI.
  // Recommend removing this function from admin UI. If needed, update stock/items_sold directly via saveProduct.
  throw new Error('patchProductStockLevels is deprecated. Use saveProduct with updated stock/items_sold.');
}

export async function deleteProduct(productId: string): Promise<void> {
  if (!supabase) {
    // Fallback to localStorage
    const saved = localStorage.getItem('flex_products');
    const products = saved ? JSON.parse(saved) : [];
    const filtered = products.filter((p: Product) => p.Product_ID !== productId);
    localStorage.setItem('flex_products', JSON.stringify(filtered));
    return;
  }

  try {
    const keysToTry = ['Product_ID', 'id', 'product_id'];
    let lastError: any = null;

    for (const key of keysToTry) {
      const { error } = await supabase
        .from('products')
        .delete()
        .eq(key, productId);
        
      if (!error) {
        return; // Success
      }
      
      // If error is not a "missing column" error, it's a real DB error (like Foreign Key constraint)
      if (error.code !== 'PGRST204' && !String(error.message).includes(key)) {
        throw error;
      }
      
      lastError = error;
    }

    if (lastError) throw lastError;

  } catch (error: any) {
    console.error('Error deleting product:', error);
    if (error?.code === '23503') {
      throw new Error('This product cannot be deleted because it is tied to existing orders. Please cancel or delete the related orders first, or just mark the product as "Discontinued".');
    }
    throw error;
  }
}

export async function updateProductStock(
  productId: string,
  quantityChange: number
): Promise<void> {
  if (!supabase) {
    // Fallback to localStorage
    const saved = localStorage.getItem('flex_products');
    const products = saved ? JSON.parse(saved) : [];
    const product = products.find((p: Product) => p.Product_ID === productId);
    if (product) {
      product.pieces = Math.max(0, product.pieces - quantityChange);
      product.sold = (product.sold || 0) + quantityChange;
      localStorage.setItem('flex_products', JSON.stringify(products));
    }
    return;
  }

  try {
    // Get current product
    const { data: product, error: fetchError } = await supabase
      .from('products')
      .select('Stock, Items_Sold')
      .eq('Product_ID', productId)
      .single();

    if (fetchError || !product) {
      throw new Error(`Stock update failed: product ${productId} not found.`);
    }

    const stock = Math.floor(Number((product as any).Stock || 0));
    const itemsSold = Math.floor(Number((product as any).Items_Sold || 0));
    if (!Number.isInteger(stock) || !Number.isInteger(itemsSold) || stock < 0 || itemsSold < 0 || itemsSold > stock) {
      throw new Error('Invalid stock values in DB.');
    }

    // Only allow incrementing items_sold (for a sale), or decrementing (for a return/cancel)
    const newItemsSold = itemsSold + quantityChange;
    if (newItemsSold < 0 || newItemsSold > stock) {
      throw new Error('Stock update failed: items_sold would be out of bounds.');
    }

    const { error } = await supabase
      .from('products')
      .update({ Items_Sold: newItemsSold })
      .eq('Product_ID', productId);

    if (error) throw error;
  } catch (error) {
    console.error('Error updating product stock:', error);
    throw error;
  }
}

export async function updateProductSizeStock(productId: string, size: string, quantityChange: number): Promise<void> {
  const normalizedSize = String(size || '').trim();
  const delta = Math.floor(Number(quantityChange));
  if (!normalizedSize || !Number.isFinite(delta) || delta === 0) return;

  if (!supabase) {
    const saved = localStorage.getItem('flex_products');
    const products: Product[] = saved ? JSON.parse(saved) : [];
    const product = products.find((item) => item.Product_ID === productId);
    if (product) {
      const nextSizeStock = normalizeSizeStockFromRow({ size_stock: product.sizeStock || [] }).length > 0
        ? (product.sizeStock || []).map((entry) => entry.size === normalizedSize ? { ...entry, stock: Math.max(0, entry.stock - delta) } : entry)
        : product.sizeStock;
      product.sizeStock = nextSizeStock;
      product.pieces = Math.max(0, Number(product.pieces || 0) - delta);
      localStorage.setItem('flex_products', JSON.stringify(products));
    }
    return;
  }

  try {
    const { data: product, error: fetchError } = await supabase
      .from('products')
      .select('size_stock, pieces')
      .eq('Product_ID', productId)
      .single();

    if (fetchError || !product) {
      throw new Error(`Stock update failed: product ${productId} not found.`);
    }

    const currentEntries = normalizeSizeStockFromRow(product);
    const nextEntries = currentEntries.map((entry) => entry.size === normalizedSize ? { ...entry, stock: Math.max(0, entry.stock - delta) } : entry);
    const nextPieces = Math.max(0, Number((product as any).pieces || 0) - delta);

    const { error } = await supabase
      .from('products')
      .update({ size_stock: nextEntries, pieces: nextPieces })
      .eq('Product_ID', productId);

    if (error) throw error;
  } catch (error) {
    console.error('Error updating product size stock:', error);
    throw error;
  }
}

// ==================== ORDERS ====================

export async function getOrders(): Promise<Order[]> {
  if (!supabase) {
    // Fallback to localStorage
    const saved = localStorage.getItem('flex_orders');
    return saved ? JSON.parse(saved) : [];
  }

  try {
    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('*')
      .order('date', { ascending: false });

    if (ordersError) throw ordersError;

    // Fetch order items for each order
    const ordersWithItems = await Promise.all(
      (orders || []).map(async (order: any) => {
        const { data: items, error: itemsError } = await supabase
          .from('order_items')
          .select('*')
          .eq('order_id', order.id);

        if (itemsError) throw itemsError;

        return {
          id: order.id,
          customerName: order.customer_name,
          customerEmail: order.customer_email,
          customerPhone: order.customer_phone,
          governorate: order.governorate,
          district: order.district,
          village: order.village,
          addressDetails: order.address_details,
          items: (items || []).map((item: any) => ({
            productId: item.product_id,
            productName: item.product_name,
            quantity: item.quantity,
            size: item.size,
            price: parseFloat(item.price),
          })),
          total: parseFloat(order.total),
          status: order.status,
          date: order.date,
        };
      })
    );

    // Keep fallback cache aligned with database to avoid stale rollback on refresh.
    localStorage.setItem('flex_orders', JSON.stringify(ordersWithItems));
    return ordersWithItems;
  } catch (error) {
    console.error('Error fetching orders:', error);
    // Fallback to localStorage
    const saved = localStorage.getItem('flex_orders');
    return saved ? JSON.parse(saved) : [];
  }
}

export async function saveOrder(order: Order): Promise<void> {
  if (!supabase) {
    // Fallback to localStorage
    const saved = localStorage.getItem('flex_orders');
    const orders = saved ? JSON.parse(saved) : [];
    orders.unshift(order);
    localStorage.setItem('flex_orders', JSON.stringify(orders));
    await notifyAdminOrderCreated(order);
    await notifyCustomerOrderReceived(order);
    return;
  }

  try {
    // Insert order
    const { data: orderData, error: orderError } = await supabase
      .from('orders')
      .insert({
        id: order.id,
        customer_name: order.customerName,
        customer_email: order.customerEmail,
        customer_phone: order.customerPhone,
        governorate: order.governorate,
        district: order.district,
        village: order.village,
        address_details: order.addressDetails,
        total: order.total,
        status: order.status,
        date: order.date,
      })
      .select()
      .single();

    if (orderError) throw orderError;

    // Insert order items
    if (order.items && order.items.length > 0) {
      const itemsToInsert = order.items.map((item) => {
        // Validation: ensure non-null/undefined values for required columns
        const productId = String(item.productId || '').trim();
        if (!productId) {
          throw new Error('Order item is missing a valid productId.');
        }

        return {
          order_id: order.id,
          product_id: productId,
          product_name: String(item.productName || item.productId || 'Unknown Item').trim(),
          quantity: Math.max(1, Number(item.quantity) || 1),
          size: String(item.size || 'N/A').trim(),
          price: Number(item.price) || 0,
          reservation_id: item.reservationId || null,
        };
      });

      console.log('DEBUG: Attempting to insert order_items payload:', JSON.stringify(itemsToInsert, null, 2));

      const { data: itemsData, error: itemsError } = await supabase
        .from('order_items')
        .insert(itemsToInsert)
        .select();

      if (itemsError) {
        console.error('CRITICAL: Supabase order_items insertion failed.', {
          error: itemsError,
          payload: itemsToInsert,
          details: itemsError.details,
          hint: itemsError.hint,
          message: itemsError.message,
          code: itemsError.code
        });
        throw itemsError;
      }
      
      console.log('SUCCESS: Order items inserted successfully:', itemsData);
    }

    const reservationIds = (order.items || [])
      .map((item) => String((item as any).reservationId || '').trim())
      .filter(Boolean);

    if (reservationIds.length > 0) {
      try {
        await commitCheckoutReservations(order.id, reservationIds);
      } catch (reservationError) {
        await supabase.from('orders').delete().eq('id', order.id);
        throw reservationError;
      }
    }

    await notifyAdminOrderCreated(order);
    await notifyCustomerOrderReceived(order);
  } catch (error) {
    console.error('CRITICAL: Error saving order to database:', error);
    if (error && typeof error === 'object') {
      const e = error as any;
      console.error('Error Details:', {
        message: e.message,
        details: e.details,
        hint: e.hint,
        code: e.code
      });
    }
    throw error;
  }
}

export async function updateOrderStatus(
  orderId: string,
  status: 'pending' | 'shipped' | 'delivered' | 'cancelled'
): Promise<void> {
  if (!supabase) {
    // Fallback to localStorage
    const saved = localStorage.getItem('flex_orders');
    const orders = saved ? JSON.parse(saved) : [];
    const order = orders.find((o: Order) => o.id === orderId);
    if (order) {
      const previousStatus = order.status;
      if (previousStatus === status) return;

      if (previousStatus === 'pending' && status === 'shipped') {
        const savedProducts = localStorage.getItem('flex_products');
        const products = savedProducts ? JSON.parse(savedProducts) : [];

        for (const item of order.items || []) {
          const p = products.find((product: Product) => product.Product_ID === item.productId);
          if (!p) {
            throw new Error('Sorry, this item is currently out of stock.');
          }

          const qty = Math.max(0, Number(item.quantity || 0));
          const currentLeft = Math.max(0, Number(p.pieces || 0));
          if (qty > currentLeft) {
            throw new Error('Sorry, this item is currently out of stock.');
          }

          p.sold = Math.max(0, Number(p.sold || 0) + qty);
          p.pieces = Math.max(0, currentLeft - qty);
          p.status = p.pieces === 0 ? 'Temporarily unavailable' : 'In Stock';
        }

        localStorage.setItem('flex_products', JSON.stringify(products));
      }

      order.status = status;
      localStorage.setItem('flex_orders', JSON.stringify(orders));

      if (previousStatus === 'pending' && status === 'shipped') {
        await notifyCustomerOrderDispatched(order);
      }
    }
    return;
  }

  try {
    const { data: existingOrder, error: fetchError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (fetchError) throw fetchError;
    if (!existingOrder) throw new Error(`Order ${orderId} was not found.`);
    if (existingOrder.status === status) return;

    // Apply inventory updates only when admin dispatches/approves (pending -> shipped)
    // and only for legacy orders that were not already committed at checkout.
    if (existingOrder.status === 'pending' && status === 'shipped') {
      const { data: confirmedReservationRows, error: confirmedReservationError } = await supabase
        .from('stock_reservations')
        .select('id')
        .eq('order_id', orderId)
        .eq('status', 'confirmed')
        .limit(1);

      if (confirmedReservationError) {
        throw confirmedReservationError;
      }

      const hasCommittedAtCheckout = Array.isArray(confirmedReservationRows) && confirmedReservationRows.length > 0;
      if (hasCommittedAtCheckout) {
        const { error: orderUpdateError } = await supabase
          .from('orders')
          .update({ status })
          .eq('id', orderId);

        if (orderUpdateError) throw orderUpdateError;

        const { data: itemRowsForMail } = await supabase
          .from('order_items')
          .select('product_id,product_name,size,quantity,price')
          .eq('order_id', orderId);

        const dispatchOrder: Order = {
          id: String((existingOrder as any).id),
          customerName: String((existingOrder as any).customer_name || ''),
          customerEmail: String((existingOrder as any).customer_email || ''),
          customerPhone: String((existingOrder as any).customer_phone || ''),
          governorate: String((existingOrder as any).governorate || ''),
          district: String((existingOrder as any).district || ''),
          village: String((existingOrder as any).village || ''),
          addressDetails: String((existingOrder as any).address_details || ''),
          items: (itemRowsForMail || []).map((row: any) => ({
            productId: String(row.product_id || ''),
            productName: String(row.product_name || row.product_id || ''),
            quantity: Math.max(0, Number(row.quantity || 0)),
            size: String(row.size || ''),
            price: Math.max(0, Number(row.price || 0)),
          })),
          total: Math.max(0, Number((existingOrder as any).total || 0)),
          status: 'shipped',
          date: String((existingOrder as any).date || new Date().toISOString()),
        };

        await notifyCustomerOrderDispatched(dispatchOrder);
        return;
      }

      const { data: itemRows, error: itemsFetchError } = await supabase
        .from('order_items')
        .select('product_id,product_name,size,quantity,price')
        .eq('order_id', orderId);

      if (itemsFetchError) throw itemsFetchError;

      const { data: allProductsRows, error: productsFetchError } = await supabase
        .from('products')
        .select('*');

      if (productsFetchError) throw productsFetchError;
      const allProducts = (allProductsRows || []) as any[];

      const grouped = new Map<string, { productId: string; size: string; quantity: number }>();
      for (const row of itemRows || []) {
        const productId = String((row as any).product_id || '').trim();
        const size = String((row as any).size || '').trim();
        const qty = Math.max(0, toNumberOrNull((row as any).quantity) ?? 0);
        if (!productId || qty <= 0) continue;

        const key = `${productId}::${size.toUpperCase()}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.quantity += qty;
        } else {
          grouped.set(key, { productId, size, quantity: qty });
        }
      }

      type Snapshot = {
        productId: string;
        leftInStock: number;
        sold: number;
        status: string;
      };

      const snapshots: Snapshot[] = [];

      for (const line of grouped.values()) {
        const product = allProducts.find((p: any) => {
          const candidateIds = [p.Product_ID]
            .map((v) => String(v || '').trim())
            .filter(Boolean);
          return candidateIds.includes(line.productId);
        }) as any;
        if (!product) {
          throw new Error('Sorry, this item is currently out of stock.');
        }

        const allowedSizes = [
          ...String(product.SIZE || '').split(',').map((s) => s.trim()),
          ...((Array.isArray(product.sizes) ? product.sizes : []) as string[]).map((s) => String(s).trim()),
        ]
          .map((s) => s.toUpperCase())
          .filter(Boolean);
        if (line.size && allowedSizes.length > 0 && !allowedSizes.includes(line.size.toUpperCase())) {
          throw new Error('Sorry, this item is currently out of stock.');
        }

        const currentStock = Math.max(0, toNumberOrNull(product.Items_LEFT_in_stock ?? product.items_left_in_stock ?? product.pieces ?? product.Stock ?? product.stock) ?? 0);
        const currentSold = Math.max(0, toNumberOrNull(product.Items_Sold ?? product.items_sold ?? product.sold) ?? 0);
        if (line.quantity > currentStock) {
          throw new Error('Sorry, this item is currently out of stock.');
        }

        const nextStock = Math.max(0, currentStock - line.quantity);
        const nextSold = Math.max(0, currentSold + line.quantity);
        const nextStatus = nextStock === 0 ? 'Temporarily unavailable' : 'In Stock';
        const normalizedLineSize = String(line.size || '').trim().toUpperCase();

        snapshots.push({
          productId: String(product.Product_ID || line.productId),
          leftInStock: currentStock,
          sold: currentSold,
          status: String(product.Status || product.status || ''),
        });

        const updatePayload: any = {};
        if ('Items_LEFT_in_stock' in product) updatePayload.Items_LEFT_in_stock = nextStock;
        if ('items_left_in_stock' in product) updatePayload.items_left_in_stock = nextStock;
        if ('pieces' in product) updatePayload.pieces = nextStock;
        if ('Items_Sold' in product) updatePayload.Items_Sold = nextSold;
        if ('items_sold' in product) updatePayload.items_sold = nextSold;
        if ('sold' in product) updatePayload.sold = nextSold;
        if ('Status' in product) updatePayload.Status = nextStatus;
        if ('status' in product) updatePayload.status = nextStatus;

        const rawSizeStock = product.size_stock ?? product.sizeStock;
        if (Array.isArray(rawSizeStock)) {
          const nextSizeStock = rawSizeStock
            .map((entry: any) => ({
              size: String(entry?.size || '').trim(),
              stock: Math.max(0, Math.floor(Number(entry?.stock || 0))),
            }))
            .filter((entry: { size: string; stock: number }) => entry.size)
            .map((entry: { size: string; stock: number }) => {
              const matches = normalizedLineSize && entry.size.toUpperCase() === normalizedLineSize;
              if (!matches) return entry;
              return {
                ...entry,
                stock: Math.max(0, entry.stock - line.quantity),
              };
            });

          if ('size_stock' in product) updatePayload.size_stock = nextSizeStock;
          if ('sizeStock' in product) updatePayload.sizeStock = nextSizeStock;
        }

        if (Object.keys(updatePayload).length === 0) {
          throw new Error('Failed to update product stock columns in database schema.');
        }

        const { error: productUpdateError } = await supabase
          .from('products')
          .update(updatePayload)
          .eq('Product_ID', line.productId);

        if (productUpdateError) {
          throw productUpdateError;
        }
      }

      const { error: orderUpdateError } = await supabase
        .from('orders')
        .update({ status })
        .eq('id', orderId);

      if (orderUpdateError) {
        for (const s of snapshots) {
          await supabase
            .from('products')
            .update({
              Items_Sold: s.sold,
              Items_LEFT_in_stock: s.leftInStock,
              Status: s.status || (s.leftInStock === 0 ? 'Temporarily unavailable' : 'In Stock'),
            })
            .eq('Product_ID', s.productId);
        }
        throw orderUpdateError;
      }

      await recalculateFinancialMetrics();

      const dispatchOrder: Order = {
        id: String((existingOrder as any).id),
        customerName: String((existingOrder as any).customer_name || ''),
        customerEmail: String((existingOrder as any).customer_email || ''),
        customerPhone: String((existingOrder as any).customer_phone || ''),
        governorate: String((existingOrder as any).governorate || ''),
        district: String((existingOrder as any).district || ''),
        village: String((existingOrder as any).village || ''),
        addressDetails: String((existingOrder as any).address_details || ''),
        items: (itemRows || []).map((row: any) => ({
          productId: String(row.product_id || ''),
          productName: String(row.product_name || row.product_id || ''),
          quantity: Math.max(0, Number(row.quantity || 0)),
          size: String(row.size || ''),
          price: Math.max(0, Number(row.price || 0)),
        })),
        total: Math.max(0, Number((existingOrder as any).total || 0)),
        status: 'shipped',
        date: String((existingOrder as any).date || new Date().toISOString()),
      };

      await notifyCustomerOrderDispatched(dispatchOrder);
      return;
    }

    const { error } = await supabase
      .from('orders')
      .update({ status })
      .eq('id', orderId);

    if (error) throw error;
  } catch (error) {
    console.error('Error updating order status:', error);
    throw error;
  }
}

export async function deleteOrder(orderId: string): Promise<void> {
  if (!supabase) {
    // Fallback to localStorage
    const saved = localStorage.getItem('flex_orders');
    const orders = saved ? JSON.parse(saved) : [];
    const filtered = orders.filter((o: Order) => o.id !== orderId);
    localStorage.setItem('flex_orders', JSON.stringify(filtered));
    return;
  }

  try {
    // Order items will be deleted automatically due to CASCADE
    const { error } = await supabase
      .from('orders')
      .delete()
      .eq('id', orderId);

    if (error) throw error;
  } catch (error) {
    console.error('Error deleting order:', error);
    throw error;
  }
}

// ==================== FINANCIAL METRICS ====================

function buildFinancialMetricsFromOrderHistory(
  orders: Array<{ id: string; status?: string }>,
  orderItems: Array<{ product_id: string; product_name?: string; quantity: number; price: number; order_id: string }>,
  products: any[]
): FinancialMetric[] {
  const completedOrderIds = new Set(
    orders
      .filter((o) => {
        const normalized = String(o.status || '').toLowerCase();
        return normalized === 'shipped' || normalized === 'delivered';
      })
      .map((o) => String(o.id))
  );

  const costByProductId = new Map<string, number>();
  for (const p of products) {
    const id = String(p.Product_ID || p.id || '').trim();
    if (!id) continue;
    const cost = Math.max(0, toNumberOrNull(p.Cost ?? p.cost) ?? 0);
    costByProductId.set(id, cost);
  }

  const grouped = new Map<string, { productName: string; itemsSold: number; revenue: number }>();
  for (const item of orderItems) {
    const orderId = String(item.order_id || '');
    if (!completedOrderIds.has(orderId)) continue;

    const productId = String(item.product_id || '').trim();
    if (!productId) continue;

    const qty = Math.max(0, toNumberOrNull(item.quantity) ?? 0);
    const price = Math.max(0, toNumberOrNull(item.price) ?? 0);
    const productName = String(item.product_name || productId).trim() || productId;

    const current = grouped.get(productId) || { productName, itemsSold: 0, revenue: 0 };
    current.itemsSold += qty;
    current.revenue += qty * price;
    if (!current.productName && productName) current.productName = productName;
    grouped.set(productId, current);
  }

  return Array.from(grouped.entries()).map(([productId, row]) => {
    const itemCost = costByProductId.get(productId) ?? 0;
    const itemPrice = row.itemsSold > 0 ? row.revenue / row.itemsSold : 0;
    const netProfit = row.revenue - (itemCost * row.itemsSold);

    return {
      productId,
      productName: row.productName || productId,
      itemsSold: row.itemsSold,
      itemPrice,
      itemCost,
      revenue: row.revenue,
      netProfit,
      calculatedAt: new Date().toISOString(),
    };
  });
}

function buildTotalsFromMetrics(metrics: FinancialMetric[]): FinancialTotals {
  return {
    totalRevenue: metrics.reduce((acc, row) => acc + row.revenue, 0),
    totalNetProfit: metrics.reduce((acc, row) => acc + row.netProfit, 0),
    calculatedAt: new Date().toISOString(),
  };
}

export async function recalculateFinancialMetrics(): Promise<FinancialMetric[]> {
  if (!supabase) {
    const savedOrders = localStorage.getItem('flex_orders');
    const savedProducts = localStorage.getItem('flex_products');
    const orders: Order[] = savedOrders ? JSON.parse(savedOrders) : [];
    const products: Product[] = savedProducts ? JSON.parse(savedProducts) : [];

    const metrics = buildFinancialMetricsFromOrderHistory(
      orders.map((o) => ({ id: o.id, status: o.status })),
      orders.flatMap((o) => (o.items || []).map((it) => ({
        product_id: it.productId,
        product_name: it.productName,
        quantity: it.quantity,
        price: it.price,
        order_id: o.id,
      }))),
      products.map((p) => ({ Product_ID: p.Product_ID, Cost: p.cost }))
    );

    localStorage.setItem('flex_financial_metrics', JSON.stringify(metrics));
    localStorage.setItem('flex_financial_totals', JSON.stringify(buildTotalsFromMetrics(metrics)));
    return metrics;
  }

  try {
    // Preferred path: let database function calculate from historical order_items.
    const { error: rpcError } = await supabase.rpc('refresh_product_financial_metrics');
    if (rpcError) {
      console.warn('refresh_product_financial_metrics RPC failed, using client-side fallback:', rpcError.message);

      const [{ data: ordersRows, error: ordersError }, { data: itemRows, error: itemsError }, { data: productRows, error: productError }] = await Promise.all([
        supabase.from('orders').select('id,status'),
        supabase.from('order_items').select('order_id,product_id,product_name,quantity,price'),
        supabase.from('products').select('Product_ID,Cost,cost'),
      ]);

      if (ordersError) throw ordersError;
      if (itemsError) throw itemsError;
      if (productError) throw productError;

      const fallbackMetrics = buildFinancialMetricsFromOrderHistory(
        (ordersRows || []) as Array<{ id: string; status?: string }>,
        (itemRows || []) as Array<{ product_id: string; product_name?: string; quantity: number; price: number; order_id: string }>,
        productRows || []
      ).filter((m) => Boolean(m.productId));

      if (fallbackMetrics.length > 0) {
        const { error: fallbackUpsertError } = await supabase
          .from('product_financial_metrics')
          .upsert(
            fallbackMetrics.map((m) => ({
              product_id: m.productId,
              name_of_product: m.productName,
              items_sold: m.itemsSold,
              item_price: m.itemPrice,
              item_cost: m.itemCost,
              item_revenue: m.revenue,
              net_profit: m.netProfit,
              calculated_at: m.calculatedAt,
            })),
            { onConflict: 'product_id' }
          );
        if (fallbackUpsertError) throw fallbackUpsertError;
      }
    }

    const { data: stored, error: fetchError } = await supabase
      .from('product_financial_metrics')
      .select('*')
      .order('product_id', { ascending: true });

    if (fetchError) throw fetchError;

    const storedMetrics = (stored || []).map((row: any) => ({
      productId: String(row.product_id || ''),
      productName: String(row.name_of_product || row.product_name || row.product_id || ''),
      itemsSold: Math.max(0, toNumberOrNull(row.items_sold) ?? 0),
      itemPrice: Math.max(0, toNumberOrNull(row.item_price) ?? 0),
      itemCost: Math.max(0, toNumberOrNull(row.item_cost) ?? 0),
      revenue: Math.max(0, toNumberOrNull(row.item_revenue) ?? 0),
      netProfit: toNumberOrNull(row.net_profit) ?? 0,
      calculatedAt: row.calculated_at || new Date().toISOString(),
    }));

    const totals = buildTotalsFromMetrics(storedMetrics);
    try {
      const { error: totalsUpsertError } = await supabase
        .from('financial_dashboard_totals')
        .upsert(
          {
            id: 'global',
            total_revenue: totals.totalRevenue,
            total_net_profit: totals.totalNetProfit,
            calculated_at: totals.calculatedAt,
          },
          { onConflict: 'id' }
        );
      if (totalsUpsertError) throw totalsUpsertError;
    } catch (totalsError) {
      console.warn('Unable to upsert financial totals row:', totalsError);
    }

    localStorage.setItem('flex_financial_totals', JSON.stringify(totals));
    return storedMetrics;
  } catch (error) {
    console.error('Error recalculating financial metrics:', error);
    throw error;
  }
}

export async function getFinancialDashboardTotals(): Promise<FinancialTotals | null> {
  if (!supabase) {
    const saved = localStorage.getItem('flex_financial_totals');
    return saved ? JSON.parse(saved) : null;
  }

  try {
    const { data, error } = await supabase
      .from('financial_dashboard_totals')
      .select('*')
      .eq('id', 'global')
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      totalRevenue: Math.max(0, toNumberOrNull((data as any).total_revenue) ?? 0),
      totalNetProfit: toNumberOrNull((data as any).total_net_profit) ?? 0,
      calculatedAt: (data as any).calculated_at || new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error fetching financial dashboard totals:', error);
    return null;
  }
}