const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');

const app = express();

// ── CORS: only allow requests from our Shopify store ──
app.use(cors({
  origin: ['https://european-beauty-group-2.myshopify.com', 'https://europeanbeautygroup.com'],
  methods: ['GET', 'POST'],
  credentials: false
}));

app.use(express.json({ limit: '10kb' }));

// ── RATE LIMITING (simple in-memory) ──
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.ip;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 min
  const maxRequests = 5;

  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip).filter(t => now - t < windowMs);
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);

  if (timestamps.length > maxRequests) {
    return res.status(429).json({ status: 'error', message: 'Too many offers. Try again later.' });
  }
  next();
}

// ── CONFIG ──
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'european-beauty-group-2.myshopify.com';
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || '';
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || '';
const APP_URL = process.env.APP_URL || 'https://ebg-offer-api.onrender.com';
const PORT = process.env.PORT || 3000;
const API_VERSION = '2024-01';
const SCOPES = 'write_draft_orders,read_draft_orders,read_products';

// ── SMTP CONFIG ──
const smtpTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.ionos.de',
  port: 587,
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});

// ── Stored access token (persisted in memory, set via OAuth or env) ──
let SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || null;

// ── Simple lock to prevent race conditions on same variant ──
const processingVariants = new Set();

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'EBG Offer API',
    token_set: !!SHOPIFY_TOKEN,
    install_url: !SHOPIFY_TOKEN ? `https://${SHOPIFY_STORE}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}&redirect_uri=${APP_URL}/auth/callback` : null
  });
});

// ── OAUTH: Start install flow ──
app.get('/auth/install', (req, res) => {
  const installUrl = `https://${SHOPIFY_STORE}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}&redirect_uri=${APP_URL}/auth/callback`;
  res.redirect(installUrl);
});

// ── OAUTH: Callback — exchange code for token ──
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code parameter');

  try {
    const response = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code: code
      })
    });

    const data = await response.json();

    if (data.access_token) {
      SHOPIFY_TOKEN = data.access_token;
      console.log('[AUTH] Access token obtained successfully');
      res.send('<h1>Connected!</h1><p>EBG Offer API is now connected to your Shopify store.</p><p>You can close this window.</p>');
    } else {
      console.error('[AUTH ERROR]', data);
      res.status(500).send('Failed to get access token: ' + JSON.stringify(data));
    }
  } catch (err) {
    console.error('[AUTH ERROR]', err);
    res.status(500).send('Auth error: ' + err.message);
  }
});

// ── RECEIVE OFFER ──
app.post('/offer', rateLimit, async (req, res) => {
  try {
    const {
      product, size, listedPrice, highestOffer,
      offerPrice, email, name, productUrl, variantId
    } = req.body;

    // ── INPUT VALIDATION ──
    if (!email || typeof email !== 'string' || !email.includes('@') || email.length > 254) {
      return res.status(400).json({ status: 'error', message: 'Invalid email.' });
    }
    if (!name || typeof name !== 'string' || name.length > 100) {
      return res.status(400).json({ status: 'error', message: 'Invalid name.' });
    }
    if (!offerPrice || isNaN(parseFloat(offerPrice)) || parseFloat(offerPrice) < 1) {
      return res.status(400).json({ status: 'error', message: 'Invalid offer price.' });
    }
    if (!product || typeof product !== 'string' || product.length > 200) {
      return res.status(400).json({ status: 'error', message: 'Invalid product.' });
    }

    console.log(`[OFFER] ${product} | ${offerPrice}€ | Size: ${size}`);

    const offer = parseFloat(offerPrice);
    const threshold = parseFloat(highestOffer);

    // ── CHECK STOCK before doing anything ──
    if (variantId) {
      // Prevent race condition: if another offer for same variant is being processed
      if (processingVariants.has(variantId)) {
        console.log(`[RACE] Variant ${variantId} already being processed`);
        return res.json({
          status: 'sold_out',
          message: 'Someone else is completing a purchase for this item right now. Try again shortly.'
        });
      }

      const stock = await checkVariantStock(variantId);
      if (stock <= 0) {
        console.log(`[SOLD OUT] Variant ${variantId} — stock: ${stock}`);
        return res.json({
          status: 'sold_out',
          message: 'Sorry, this item just sold out.'
        });
      }

      // Lock variant while processing
      processingVariants.add(variantId);
    }

    // Release lock immediately — we'll process async
    if (variantId) processingVariants.delete(variantId);

    if (offer >= threshold) {
      // ── AUTO-ACCEPT: delay for realism ──
      const delayMin = 0; // TESTING MODE — change to: Math.floor(Math.random() * 120) + 1
      const delayMs = 3000; // TESTING MODE — change to: delayMin * 60 * 1000
      console.log(`[AUTO-ACCEPT] ${offer}€ >= ${threshold}€ — will process in ${delayMin} minutes`);

      // Capture all data before setTimeout (req may be gone)
      const offerData = {
        product, size, email, name, variantId,
        listedPrice: parseFloat(listedPrice),
        offerPrice: offer,
        watchers: req.body.watchers || '0'
      };

      // Process in background after delay
      setTimeout(async () => {
        try {
          // Re-check stock before creating draft order
          if (offerData.variantId) {
            const stock = await checkVariantStock(offerData.variantId);
            if (stock <= 0) {
              console.log(`[EXPIRED] Variant ${offerData.variantId} sold out before delayed accept`);
              return;
            }
          }

          console.log(`[PROCESSING] Creating draft order...`);
          const draftResult = await createDraftOrder(offerData);

          if (draftResult.success) {
            console.log(`[DRAFT ORDER] Created #${draftResult.draftOrderId} (after ${delayMin}min delay)`);
            console.log(`[SENDING EMAIL] to ${offerData.email} with invoice URL: ${draftResult.invoiceUrl}`);

            // Send Shopify's built-in invoice (reliable)
            try {
              await sendShopifyInvoice(draftResult.draftOrderId, offerData);
              console.log(`[INVOICE] Shopify invoice sent for ${offerData.product}`);
            } catch (invoiceErr) {
              console.error(`[INVOICE ERROR] ${invoiceErr.message}`);
            }

            // Also try custom branded email (optional, may fail on free tier)
            try {
              await sendCustomEmail({
                ...offerData,
                invoiceUrl: draftResult.invoiceUrl
              });
              console.log(`[CUSTOM EMAIL] Branded email sent for ${offerData.product}`);
            } catch (emailErr) {
              console.log(`[CUSTOM EMAIL] Skipped — SMTP unavailable: ${emailErr.message}`);
            }

            // Schedule expiry check (24h from invoice sent)
            setTimeout(() => checkAndExpire(draftResult.draftOrderId, offerData.variantId), 24 * 60 * 60 * 1000);
          } else {
            console.error(`[ERROR] Draft order failed:`, draftResult.error);
          }
        } catch (err) {
          console.error(`[ERROR] Delayed processing failed:`, err.message);
          console.error(`[ERROR STACK]`, err.stack);
        }
      }, delayMs);

      // Respond immediately to customer
      return res.json({
        status: 'submitted',
        message: 'Offer submitted for review.'
      });

    } else {
      // ── BELOW THRESHOLD: notify for manual review ──
      console.log(`[PENDING] ${offer}€ < ${threshold}€ — needs manual review`);

      await sendContactForm({ product, size, listedPrice, highestOffer, offerPrice: offer, email, name, productUrl });

      return res.json({
        status: 'submitted',
        message: 'Offer submitted for review.'
      });
    }

  } catch (err) {
    console.error('[ERROR]', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── CHECK VARIANT STOCK via Shopify Admin API ──
async function checkVariantStock(variantId) {
  try {
    const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/variants/${variantId}.json`;
    const response = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    });
    const data = await response.json();

    if (data.variant) {
      const qty = data.variant.inventory_quantity || 0;
      console.log(`[STOCK CHECK] Variant ${variantId}: ${qty} in stock`);
      return qty;
    }
    return 0;
  } catch (err) {
    console.error(`[STOCK CHECK ERROR]`, err.message);
    return 0; // fail safe: treat as sold out
  }
}

// ── CREATE DRAFT ORDER ──
async function createDraftOrder({ product, size, listedPrice, offerPrice, email, name, variantId }) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/draft_orders.json`;

  let lineItems;
  if (variantId) {
    lineItems = [{
      variant_id: parseInt(variantId),
      quantity: 1,
      applied_discount: {
        title: 'Accepted Offer',
        value: (listedPrice - offerPrice).toFixed(2),
        value_type: 'fixed_amount',
        description: `Binding offer accepted at ${offerPrice}€`
      }
    }];
  } else {
    lineItems = [{
      title: `${product} (Size: ${size})`,
      price: offerPrice.toString(),
      quantity: 1
    }];
  }

  const payload = {
    draft_order: {
      line_items: lineItems,
      email: email,
      note: `BINDING OFFER — Auto-accepted\nOriginal: ${listedPrice}€ → Offer: ${offerPrice}€\nCustomer: ${name}\nSize: ${size}\nItem not reserved — first to pay secures it.`,
      tags: 'offer,auto-accepted',
      use_customer_default_address: true
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (data.draft_order) {
      return {
        success: true,
        draftOrderId: data.draft_order.id,
        invoiceUrl: data.draft_order.invoice_url
      };
    }
    return { success: false, error: JSON.stringify(data) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── SEND BRANDED INVOICE WITH FOMO ──
// ── SEND SHOPIFY'S BUILT-IN INVOICE (always works) ──
async function sendShopifyInvoice(draftOrderId, data) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/draft_orders/${draftOrderId}/send_invoice.json`;
  const watchers = parseInt(data.watchers) || 0;

  await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      draft_order_invoice: {
        to: data.email,
        subject: `Your offer has been accepted — ${data.product} | E.B.G. Archive`,
        custom_message: watchers > 0 ? `${watchers} people have made offers on this item. Complete your payment within 24 hours to secure it.` : 'Complete your payment within 24 hours to secure your item.'
      }
    })
  });
}

// ── SEND CUSTOM BRANDED EMAIL (optional, via SMTP) ──
async function sendCustomEmail(data) {
  const { email, product, size, offerPrice, listedPrice, watchers, invoiceUrl } = data;

  const savings = (listedPrice - offerPrice).toFixed(2);
  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const deadlineStr = deadline.toLocaleString('en-GB', {
    timeZone: 'Europe/Berlin',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  });

  const watcherCount = parseInt(watchers) || 0;
  const watcherHtml = watcherCount > 0
    ? `<div style="text-align:center;font-size:11px;color:#888;margin-top:16px;">
        <span style="display:inline-block;width:6px;height:6px;background:#8B0000;border-radius:50;vertical-align:middle;margin-right:4px;"></span>
        ${watcherCount} people have made offers on this item
      </div>`
    : '';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:Arial,Helvetica,sans-serif;color:#1A1A1A;">
  <div style="max-width:560px;margin:0 auto;padding:40px 20px;">
    <div style="background:#fff;border:1.5px solid #1A1A1A;padding:36px 32px;">

      <div style="font-family:'Arial Black',Arial,sans-serif;font-weight:900;font-size:14px;text-transform:uppercase;letter-spacing:0.08em;text-align:center;margin-bottom:32px;">European Beauty Group</div>

      <div style="display:inline-block;background:#1A1A1A;color:#fff;font-family:'Arial Black',Arial,sans-serif;font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;padding:6px 14px;margin-bottom:20px;">Offer Accepted</div>

      <h1 style="font-family:'Arial Black',Arial,sans-serif;font-weight:900;font-size:22px;text-transform:uppercase;margin:0 0 6px;line-height:1.3;">${product}</h1>
      <div style="font-size:13px;color:#888;margin-bottom:24px;">Size: ${size}</div>

      <hr style="border:none;border-top:1px solid #E0E0E0;margin:24px 0;">

      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:13px;padding:6px 0;color:#888;text-decoration:line-through;">Original Price</td>
          <td align="right" style="font-size:13px;padding:6px 0;color:#888;text-decoration:line-through;">${listedPrice.toFixed(2)}€</td>
        </tr>
        <tr>
          <td style="font-size:15px;font-weight:900;padding:6px 0;">Your Offer</td>
          <td align="right" style="font-size:15px;font-weight:900;padding:6px 0;">${offerPrice.toFixed(2)}€</td>
        </tr>
        <tr>
          <td style="font-size:13px;font-weight:700;padding:6px 0;color:#8B0000;">You Save</td>
          <td align="right" style="font-size:13px;font-weight:700;padding:6px 0;color:#8B0000;">-${savings}€</td>
        </tr>
      </table>

      <hr style="border:none;border-top:1px solid #E0E0E0;margin:24px 0;">

      <div style="background:#1A1A1A;color:#fff;padding:20px;margin:24px 0;text-align:center;">
        <div style="font-family:'Arial Black',Arial,sans-serif;font-weight:900;font-size:14px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">⚠ Pay within 24 hours</div>
        <div style="font-size:12px;color:#AAA;">Deadline: ${deadlineStr}</div>
        <div style="font-size:11px;color:#888;margin-top:10px;line-height:1.5;">This is a one-of-a-kind piece and is still available to other buyers.<br>Complete your payment now to secure it.</div>
      </div>

      <div style="text-align:center;margin:28px 0 8px;">
        <a href="${invoiceUrl}" style="display:inline-block;background:#1A1A1A;color:#fff;font-family:'Arial Black',Arial,sans-serif;font-weight:900;font-size:13px;text-transform:uppercase;letter-spacing:0.04em;padding:16px 48px;text-decoration:none;border:1.5px solid #1A1A1A;">Complete Payment</a>
      </div>

      ${watcherHtml}

    </div>

    <div style="text-align:center;margin-top:32px;font-size:11px;color:#AAA;line-height:1.6;">
      <strong>European Beauty Group</strong><br>
      <a href="https://europeanbeautygroup.com" style="color:#888;">europeanbeautygroup.com</a><br><br>
      This is a transactional email regarding your offer.<br>
      Your data is only used to process this offer — no marketing.<br><br>
      Questions? Contact <a href="mailto:business@europeanbeautygroup.com" style="color:#888;">business@europeanbeautygroup.com</a>
    </div>
  </div>
</body>
</html>`;

  await smtpTransport.sendMail({
    from: '"European Beauty Group" <' + (process.env.SMTP_USER || 'offer@europeanbeautygroup.com') + '>',
    replyTo: 'business@europeanbeautygroup.com',
    to: email,
    subject: `✓ Offer Accepted — ${product} for ${offerPrice}€ | E.B.G. Archive`,
    html: html
  });
}

// ── CHECK & EXPIRE UNPAID DRAFT ORDERS (24h) ──
async function checkAndExpire(draftOrderId, variantId) {
  try {
    const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/draft_orders/${draftOrderId}.json`;
    const response = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    });
    const data = await response.json();

    if (data.draft_order && data.draft_order.status === 'open') {
      console.log(`[EXPIRED] Draft order #${draftOrderId} — not paid after 24h, deleting`);
      await fetch(url, {
        method: 'DELETE',
        headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
      });
    } else {
      console.log(`[COMPLETED] Draft order #${draftOrderId} — status: ${data.draft_order?.status}`);
    }
  } catch (err) {
    console.error(`[EXPIRY CHECK ERROR] ${draftOrderId}:`, err.message);
  }
}

// ── FALLBACK: Shopify contact form for manual review ──
async function sendContactForm({ product, size, listedPrice, highestOffer, offerPrice, email, name, productUrl }) {
  try {
    const formBody = new URLSearchParams();
    formBody.append('form_type', 'contact');
    formBody.append('utf8', '✓');
    formBody.append('contact[email]', email);
    formBody.append('contact[body]',
      `BINDING OFFER (manual review)\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Product: ${product}\nSize: ${size}\n` +
      `Listed: ${listedPrice}€\nHighest Offer: ${highestOffer}€\nOffer: ${offerPrice}€\n` +
      `Customer: ${name}\nEmail: ${email}\n` +
      `URL: ${productUrl}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    );

    await fetch(`https://${SHOPIFY_STORE}/contact#contact_form`, {
      method: 'POST',
      body: formBody
    });
  } catch (err) {
    console.error('[CONTACT FORM ERROR]', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`EBG Offer API running on port ${PORT}`);
});
