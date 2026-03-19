// Database service layer for Supabase operations
// This will replace localStorage with real database calls

import { supabase } from './supabase';
import { Product, ProductGender, Order, FinancialMetric, FinancialTotals } from '../types';

const ADMIN_NOTIFICATION_EMAIL = 'flexfitslebanon@gmail.com';
const EMAIL_WEBHOOK_URL = String(import.meta.env.VITE_EMAIL_WEBHOOK_URL || '').trim();
const EMAIL_WEBHOOK_SECRET = String(import.meta.env.VITE_EMAIL_WEBHOOK_SECRET || '').trim();
const SITE_URL = String(
  import.meta.env.VITE_SITE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000')
).trim();
const DEFAULT_PRODUCT_IMAGE = '/flex-logo-bbg.JPG';

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
  const candidate = String(value || '').trim();
  if (!candidate) return DEFAULT_PRODUCT_IMAGE;
  if (/^https?:\/\/via\.placeholder\.com\//i.test(candidate)) return DEFAULT_PRODUCT_IMAGE;
  return candidate;
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

// ==================== PRODUCTS ====================

function toNumberOrNull(value: any): number | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().replace(/,/g, '');
  if (normalized === '') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
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

    // Transform database format to app format
    const transformed = (data || []).map((p: any) => ({
      // Support both quoted-uppercase and lower/snake-case columns.
      // pieces falls back to Stock to avoid false "Depleted" badges when left-stock is empty in imported CSV rows.
      _piecesRaw: toNumberOrNull(p.Items_LEFT_in_stock ?? p.items_left_in_stock ?? p.pieces),
      _stockRaw: toNumberOrNull(p.Stock ?? p.stock ?? p.initial_stock),
      _soldRaw: toNumberOrNull(p.Items_Sold ?? p.items_sold ?? p.sold),
      id: p.Product_ID || p.id,
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
      sizes: (p.SIZE ? String(p.SIZE).split(',').map((s: string) => s.trim()).filter(Boolean) : []) || p.sizes || [],
      description: p.Description || p.description || '',
      image: normalizeProductImage(p.Pictures || p.pictures || p.picture || p.image),
      isAuthentic: p.is_authentic ?? true,
      status: p.Status || p.status,
    })).map((product: any) => {
      delete product._piecesRaw;
      delete product._stockRaw;
      delete product._soldRaw;
      return product as Product;
    });

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
    const existing = products.findIndex((p: Product) => p.id === product.id);
    if (existing >= 0) {
      products[existing] = product;
    } else {
      products.unshift(product);
    }
    localStorage.setItem('flex_products', JSON.stringify(products));
    return;
  }

  try {
    const basePayload: any = {
      Product_ID: product.id,
      Name_of_Brand: product.brandName || product.name,
      Name_of_Product: product.productName || product.name,
      Category: product.category,
      Type: product.type,
      Price: product.price,
      Cost: product.cost,
      Stock: product.initialStock,
      Items_LEFT_in_stock: product.pieces,
      Items_Sold: product.sold,
      SIZE: product.sizes.join(','),
      Status: product.status || 'Active',
      Pictures: product.image,
      Description: product.description,
    };

    const executeUpsert = async (payload: any) => {
      return supabase
        .from('products')
        .upsert(payload, {
          onConflict: 'Product_ID'
        });
    };

    const requestedGender = normalizeGender(product.gender);
    let { error } = await executeUpsert({ ...basePayload, Gender: requestedGender });

    if (error) {
      const errText = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase();
      const hasMissingGenderColumn = errText.includes('gender') && (errText.includes('column') || errText.includes('schema cache') || error.code === 'PGRST204');

      if (hasMissingGenderColumn) {
        const retry = await executeUpsert(basePayload);
        error = retry.error;
      }
    }

    if (error) {
      console.error('Supabase saveProduct error details:', {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      });
      throw error;
    }
  } catch (error) {
    console.error('Error saving product (full):', error);
    throw error;
  }
}

export async function deleteProduct(productId: string): Promise<void> {
  if (!supabase) {
    // Fallback to localStorage
    const saved = localStorage.getItem('flex_products');
    const products = saved ? JSON.parse(saved) : [];
    const filtered = products.filter((p: Product) => p.id !== productId);
    localStorage.setItem('flex_products', JSON.stringify(filtered));
    return;
  }

  try {
    const { error } = await supabase
      .from('products')
      .delete()
      .eq('Product_ID', productId);

    if (error) throw error;
  } catch (error) {
    console.error('Error deleting product:', error);
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
    const product = products.find((p: Product) => p.id === productId);
    if (product) {
      product.pieces = Math.max(0, product.pieces - quantityChange);
      product.sold = (product.sold || 0) + quantityChange;
      localStorage.setItem('flex_products', JSON.stringify(products));
    }
    return;
  }

  try {
    // First get current product
    const { data: product, error: fetchError } = await supabase
      .from('products')
      .select('Items_LEFT_in_stock, Items_Sold')
      .eq('Product_ID', productId)
      .single();

    if (fetchError || !product) {
      throw new Error(`Stock update failed: product ${productId} not found.`);
    }

    const currentLeft = Math.max(0, Number((product as any).Items_LEFT_in_stock || 0));
    const currentSold = Math.max(0, Number((product as any).Items_Sold || 0));
    if (currentLeft < quantityChange) {
      throw new Error(`Stock update failed: insufficient stock for ${productId}. Requested ${quantityChange}, available ${currentLeft}.`);
    }

    const { error } = await supabase
      .from('products')
      .update({
        Items_LEFT_in_stock: currentLeft - quantityChange,
        Items_Sold: currentSold + quantityChange,
      })
      .eq('Product_ID', productId);

    if (error) throw error;
  } catch (error) {
    console.error('Error updating product stock:', error);
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
      const { error: itemsError } = await supabase
        .from('order_items')
        .insert(
          order.items.map((item) => ({
            order_id: order.id,
            product_id: item.productId,
            product_name: item.productName,
            quantity: item.quantity,
            size: item.size,
            price: item.price,
          }))
        );

      if (itemsError) throw itemsError;
    }

    await notifyAdminOrderCreated(order);
    await notifyCustomerOrderReceived(order);
  } catch (error) {
    console.error('Error saving order:', error);
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
          const p = products.find((product: Product) => product.id === item.productId);
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

    // Apply inventory updates only when admin dispatches/approves (pending -> shipped).
    if (existingOrder.status === 'pending' && status === 'shipped') {
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
      products.map((p) => ({ Product_ID: p.id, Cost: p.cost }))
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

