const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG ──
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'european-beauty-group-2.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const PORT = process.env.PORT || 3000;
const API_VERSION = '2024-01';

// ── Simple lock to prevent race conditions on same variant ──
const processingVariants = new Set();

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'EBG Offer API' });
});

// ── RECEIVE OFFER ──
app.post('/offer', async (req, res) => {
  try {
    const {
      product, size, listedPrice, highestOffer,
      offerPrice, email, name, productUrl, variantId
    } = req.body;

    console.log(`[OFFER] ${product} | ${offerPrice}€ | ${name} (${email}) | Size: ${size}`);

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

    try {
      if (offer >= threshold) {
        // ── AUTO-ACCEPT ──
        console.log(`[AUTO-ACCEPT] ${offer}€ >= ${threshold}€`);

        const draftResult = await createDraftOrder({
          product, size, listedPrice: parseFloat(listedPrice),
          offerPrice: offer, email, name, variantId
        });

        if (draftResult.success) {
          console.log(`[DRAFT ORDER] Created #${draftResult.draftOrderId}`);

          // Send branded invoice with FOMO
          await sendInvoice(draftResult.draftOrderId, {
            email, product, size, offerPrice: offer, listedPrice: parseFloat(listedPrice)
          });
          console.log(`[INVOICE] Sent to ${email}`);

          // Schedule expiry check (24h)
          setTimeout(() => checkAndExpire(draftResult.draftOrderId, variantId), 24 * 60 * 60 * 1000);

          return res.json({
            status: 'accepted',
            message: 'Offer accepted! Check your email for the invoice.'
          });
        } else {
          console.error(`[ERROR] Draft order failed:`, draftResult.error);
          return res.json({ status: 'error', message: 'Failed to process offer.' });
        }

      } else {
        // ── BELOW THRESHOLD ──
        console.log(`[PENDING] ${offer}€ < ${threshold}€ — needs manual review`);

        await sendContactForm({ product, size, listedPrice, highestOffer, offerPrice: offer, email, name, productUrl });

        return res.json({
          status: 'pending',
          message: 'Offer submitted for review.'
        });
      }
    } finally {
      // Release lock
      if (variantId) processingVariants.delete(variantId);
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
      note: `BINDING OFFER — Auto-accepted\nOriginal: ${listedPrice}€ → Offer: ${offerPrice}€\nCustomer: ${name}\nSize: ${size}`,
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
async function sendInvoice(draftOrderId, { email, product, size, offerPrice, listedPrice }) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/draft_orders/${draftOrderId}/send_invoice.json`;

  const savings = (listedPrice - offerPrice).toFixed(2);
  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const deadlineStr = deadline.toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  });

  const message =
    `YOUR OFFER HAS BEEN ACCEPTED\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${product}\n` +
    `Size: ${size}\n\n` +
    `Original Price: ${listedPrice}€\n` +
    `Your Offer: ${offerPrice}€\n` +
    `You Save: ${savings}€\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚠️ IMPORTANT: Pay within 24 hours\n` +
    `Deadline: ${deadlineStr}\n\n` +
    `This is a one-of-a-kind piece. If you don't complete payment within 24 hours, your offer expires and the item becomes available to other buyers.\n\n` +
    `Click the link below to complete your payment.\n\n` +
    `— European Beauty Group`;

  await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      draft_order_invoice: {
        to: email,
        subject: `✓ Offer Accepted — ${product} for ${offerPrice}€ | E.B.G. Archive`,
        custom_message: message
      }
    })
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
