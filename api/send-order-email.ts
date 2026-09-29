import {
  allowMethod,
  assertAllowedKeys,
  getClientIp,
  normalizePlainObject,
  normalizeText,
  rateLimit,
  readJsonBody,
  sendJson,
  withTimeout,
} from './_lib/security';

const EMAIL_WEBHOOK_URL = String(process.env.EMAIL_WEBHOOK_URL || '').trim();
const EMAIL_WEBHOOK_SECRET = String(process.env.EMAIL_WEBHOOK_SECRET || '').trim();
const ADMIN_NOTIFICATION_EMAIL = String(process.env.ORDER_NOTIFICATION_EMAIL || 'flexfitslebanon@gmail.com').trim().toLowerCase();
const SITE_URL = normalizeSiteUrl(process.env.SITE_URL || process.env.VERCEL_URL || 'https://flexfitsstore.vercel.app');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SECRET_KEY = String(
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
).trim();
const MAX_BODY_BYTES = 4 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

type EmailEvent = 'order_created_admin' | 'order_received_customer' | 'order_dispatched_customer' | 'order_canceled_customer';

type OrderRow = {
  id: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  governorate: string;
  district: string;
  village: string;
  address_details: string;
  total: number;
  delivery_fee: number | null;
  status: string;
  date: string;
  reservation_session_id: string | null;
};

type OrderItemRow = {
  product_id: string;
  product_name: string;
  quantity: number;
  size: string;
  price: number;
};

function normalizeSiteUrl(value: unknown): string {
  const candidate = String(value || '').trim();
  const withProtocol = candidate && !/^https?:\/\//i.test(candidate) ? `https://${candidate}` : candidate;
  try {
    const parsed = new URL(withProtocol);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : 'https://flexfitsstore.vercel.app';
  } catch {
    return 'https://flexfitsstore.vercel.app';
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatMoney(value: unknown): string {
  const amount = Math.max(0, Number(value || 0));
  return `$${amount.toFixed(2)}`;
}

async function supabaseRest<T>(path: string, init?: RequestInit): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error('Database service unavailable.');
  }

  // Modern sb_secret_ keys authenticate through `apikey`. The legacy service-role
  // JWT also needs a Bearer header for PostgREST until it has been retired.
  const legacyAuthorization = SUPABASE_SECRET_KEY.startsWith('eyJ')
    ? { Authorization: `Bearer ${SUPABASE_SECRET_KEY}` }
    : {};
  const response = await withTimeout(
    fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        ...legacyAuthorization,
        Accept: 'application/json',
        ...(init?.headers || {}),
      },
    }),
    REQUEST_TIMEOUT_MS,
    'Database request'
  );

  if (!response.ok) throw new Error('Database request failed.');
  return response.json() as Promise<T>;
}

async function getOrder(orderId: string): Promise<OrderRow | null> {
  const select = [
    'id',
    'customer_name',
    'customer_email',
    'customer_phone',
    'governorate',
    'district',
    'village',
    'address_details',
    'total',
    'delivery_fee',
    'status',
    'date',
    'reservation_session_id',
  ].join(',');
  const rows = await supabaseRest<OrderRow[]>(
    `orders?id=eq.${encodeURIComponent(orderId)}&select=${encodeURIComponent(select)}&limit=1`
  );
  return rows[0] || null;
}

async function getOrderItems(orderId: string): Promise<OrderItemRow[]> {
  const select = 'product_id,product_name,quantity,size,price';
  return supabaseRest<OrderItemRow[]>(
    `order_items?order_id=eq.${encodeURIComponent(orderId)}&select=${encodeURIComponent(select)}`
  );
}

async function requireAdmin(req: any): Promise<void> {
  const authorization = String(req?.headers?.authorization || '').trim();
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    throw new Error('Admin authorization required.');
  }

  const userResponse = await withTimeout(
    fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: authorization,
      },
    }),
    REQUEST_TIMEOUT_MS,
    'Authentication request'
  );

  if (!userResponse.ok) throw new Error('Invalid admin session.');
  const user = await userResponse.json() as { id?: unknown };
  const userId = normalizeText(user.id, 80);
  if (!userId) throw new Error('Invalid admin session.');

  const rows = await supabaseRest<Array<{ user_id: string }>>(
    `admin_users?user_id=eq.${encodeURIComponent(userId)}&select=user_id&limit=1`
  );
  if (rows.length !== 1) throw new Error('Admin authorization required.');
}

function buildEmail(event: EmailEvent, order: OrderRow, items: OrderItemRow[]): { toEmail: string; subject: string; html: string } {
  const eventCopy: Record<EmailEvent, { title: string; intro: string; subject: string; recipient: string }> = {
    order_created_admin: {
      title: 'New Order Created',
      intro: 'A new order was placed on Flex Fits. Review and dispatch it from the admin panel.',
      subject: `New Order ${order.id} - ${order.customer_name}`,
      recipient: ADMIN_NOTIFICATION_EMAIL,
    },
    order_received_customer: {
      title: 'Order Received',
      intro: 'We received your order and will contact you when it is accepted and dispatched.',
      subject: `We received your Flex Fits Order ${order.id}`,
      recipient: String(order.customer_email || '').trim().toLowerCase(),
    },
    order_dispatched_customer: {
      title: 'Order Confirmation - Accepted and Dispatched',
      intro: 'Your order has been accepted and dispatched by Flex Fits. Thank you for your trust.',
      subject: `Your Flex Fits Order ${order.id} is Confirmed`,
      recipient: String(order.customer_email || '').trim().toLowerCase(),
    },
    order_canceled_customer: {
      title: 'Order Canceled',
      intro: 'Your order has been canceled. The order details are included below for your reference.',
      subject: `Your Flex Fits Order ${order.id} was Canceled`,
      recipient: String(order.customer_email || '').trim().toLowerCase(),
    },
  };

  const copy = eventCopy[event];
  if (!copy.recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(copy.recipient)) {
    throw new Error('Order recipient is unavailable.');
  }

  const rows = items.slice(0, 100).map((item) => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #f1f5f9;font-weight:700;color:#111827;">${escapeHtml(item.product_name)}</td>
      <td style="padding:10px;border-bottom:1px solid #f1f5f9;">${escapeHtml(item.size)}</td>
      <td style="padding:10px;border-bottom:1px solid #f1f5f9;">${Math.max(0, Math.floor(Number(item.quantity || 0)))}</td>
      <td style="padding:10px;border-bottom:1px solid #f1f5f9;">${formatMoney(item.price)}</td>
    </tr>
  `).join('');

  const totalQty = items.reduce((sum, item) => sum + Math.max(0, Math.floor(Number(item.quantity || 0))), 0);
  const location = [order.governorate, order.district, order.village].filter(Boolean).join(', ');
  const html = `
    <div style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;">
      <div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;">
        <div style="background:#111827;color:#ffffff;padding:18px 20px;">
          <div style="font-size:18px;font-weight:800;">Flex Fits</div>
          <div style="font-size:13px;opacity:0.9;">${escapeHtml(copy.title)}</div>
        </div>
        <div style="padding:20px;color:#111827;">
          <p style="margin:0 0 12px;font-size:14px;">${escapeHtml(copy.intro)}</p>
          <p style="margin:0 0 16px;font-size:13px;color:#475569;">
            Order ID: <strong>${escapeHtml(order.id)}</strong><br />
            Date: <strong>${escapeHtml(order.date)}</strong>
          </p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:14px;">
            <thead><tr style="text-align:left;background:#f8fafc;color:#475569;">
              <th style="padding:10px;">Item</th><th style="padding:10px;">Size</th>
              <th style="padding:10px;">Qty</th><th style="padding:10px;">Price</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin:0 0 6px;font-size:13px;">Total Items: <strong>${totalQty}</strong></p>
          <p style="margin:0 0 6px;font-size:13px;">Order Total: <strong>${formatMoney(order.total)}</strong></p>
          <p style="margin:0 0 6px;font-size:13px;">Customer: <strong>${escapeHtml(order.customer_name)}</strong> (${escapeHtml(order.customer_email)})</p>
          <p style="margin:0 0 6px;font-size:13px;">Phone: <strong>${escapeHtml(order.customer_phone)}</strong></p>
          <p style="margin:0 0 6px;font-size:13px;">Location: <strong>${escapeHtml(location)}</strong></p>
          <p style="margin:0 0 18px;font-size:13px;">Address Details: <strong>${escapeHtml(order.address_details)}</strong></p>
          <a href="${escapeHtml(SITE_URL)}" style="display:inline-block;padding:10px 14px;background:#ea580c;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;">Open Flex Fits</a>
        </div>
      </div>
    </div>
  `;

  return { toEmail: copy.recipient, subject: copy.subject.slice(0, 220), html };
}

export default async function handler(req: any, res: any): Promise<void> {
  if (!allowMethod(req, res, ['POST'])) return;

  const rate = rateLimit(`send-order-email:${getClientIp(req)}`, 10, 60_000);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    sendJson(res, 429, { ok: false, error: 'Too many requests.' });
    return;
  }

  const missingConfiguration = [
    !EMAIL_WEBHOOK_URL && 'EMAIL_WEBHOOK_URL',
    !EMAIL_WEBHOOK_SECRET && 'EMAIL_WEBHOOK_SECRET',
    !SUPABASE_URL && 'SUPABASE_URL',
    !SUPABASE_SECRET_KEY && 'SUPABASE_SECRET_KEY',
  ].filter(Boolean);
  if (missingConfiguration.length > 0) {
    sendJson(res, 503, {
      ok: false,
      error: 'Email service unavailable.',
      missing: missingConfiguration,
    });
    return;
  }

  try {
    const body = normalizePlainObject(await readJsonBody(req, MAX_BODY_BYTES));
    assertAllowedKeys(body, ['event', 'orderId', 'checkoutSessionId']);
    const event = normalizeText(body.event, 64) as EmailEvent;
    const orderId = normalizeText(body.orderId, 80);
    const checkoutSessionId = normalizeText(body.checkoutSessionId, 160);

    if (!['order_created_admin', 'order_received_customer', 'order_dispatched_customer', 'order_canceled_customer'].includes(event) || !orderId) {
      throw new Error('Invalid email event.');
    }

    const order = await getOrder(orderId);
    if (!order) throw new Error('Order not found.');

    if (event === 'order_created_admin' || event === 'order_received_customer') {
      if (!checkoutSessionId || checkoutSessionId !== order.reservation_session_id || String(order.status).toLowerCase() !== 'pending') {
        throw new Error('Checkout authorization failed.');
      }
    } else {
      await requireAdmin(req);
      const expectedStatus = event === 'order_dispatched_customer' ? ['shipped', 'dispatched'] : ['canceled', 'cancelled'];
      if (!expectedStatus.includes(String(order.status || '').toLowerCase())) {
        throw new Error('Order state does not match email event.');
      }
    }

    const items = await getOrderItems(orderId);
    if (items.length === 0) throw new Error('Order items unavailable.');
    const email = buildEmail(event, order, items);
    const formBody = new URLSearchParams({
      secret: EMAIL_WEBHOOK_SECRET,
      event,
      toEmail: email.toEmail,
      subject: email.subject,
      html: email.html,
      siteUrl: SITE_URL,
      adminEmail: ADMIN_NOTIFICATION_EMAIL,
      order: JSON.stringify(order),
      items: JSON.stringify(items),
    });

    const response = await withTimeout(
      fetch(EMAIL_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: formBody.toString(),
      }),
      REQUEST_TIMEOUT_MS,
      'Email webhook'
    );

    const responseText = await response.text();
    let webhookResult: { ok?: unknown; error?: unknown } | null = null;
    try {
      webhookResult = JSON.parse(responseText) as { ok?: unknown; error?: unknown };
    } catch {
      webhookResult = null;
    }

    if (!response.ok || webhookResult?.ok !== true) {
      const providerError = normalizeText(webhookResult?.error, 160) || 'Unexpected webhook response.';
      console.error('[email-webhook] Delivery rejected.', {
        status: response.status,
        error: providerError,
      });
      sendJson(res, 502, { ok: false, error: 'Email service failed.' });
      return;
    }

    sendJson(res, 200, { ok: true });
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid or unauthorized request.' });
  }
}
