// netlify/functions/create-order.js
//
// Places a preview order: no real payment yet (Stripe comes later), but
// logs the order to Airtable and sends a real confirmation email via Resend.
//
// Required environment variables:
//   AIRTABLE_TOKEN / AIRTABLE_BASE_ID  (writes to an "Orders" table)
//   RESEND_API_KEY

function generateOrderId(){
  return 'RS-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

exports.handler = async (event) => {
  const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { customerName, email, address, city, postcode, items, subtotal, discount, total } = data;

  if (!customerName || !email || !address || !city || !postcode) {
    return { statusCode: 422, headers: corsHeaders, body: JSON.stringify({ error: "Missing required fields." }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 422, headers: corsHeaders, body: JSON.stringify({ error: "Enter a valid email address." }) };
  }
  if (!Array.isArray(items) || !items.length) {
    return { statusCode: 422, headers: corsHeaders, body: JSON.stringify({ error: "Cart is empty." }) };
  }

  const orderId = generateOrderId();
  const itemsSummary = items.map(i => `${i.name} (${i.size}) x${i.qty} — £${(i.price * i.qty).toFixed(2)}`).join('\n');

  // ---- 1. Log the order to Airtable (non-fatal if it fails — the order still succeeds) ----
  try {
    await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          "Order ID": orderId,
          "Customer Name": customerName,
          "Email": email,
          "Address": `${address}, ${city}, ${postcode}`,
          "Items": itemsSummary,
          "Subtotal": subtotal,
          "Discount": discount || 0,
          "Total": total,
          "Order Date": new Date().toISOString(),
        },
      }),
    });
  } catch (err) {
    console.error("Airtable order log failed (non-fatal):", err);
  }

  // ---- 2. Send the confirmation email via Resend ----
  if (process.env.RESEND_API_KEY) {
    const itemsHtml = items.map(i =>
      `<tr><td style="padding:6px 0;">${i.name} (${i.size}) × ${i.qty}</td><td style="padding:6px 0; text-align:right;">£${(i.price * i.qty).toFixed(2)}</td></tr>`
    ).join('');

    const html = `
      <div style="font-family: Arial, sans-serif; max-width:480px; margin:0 auto; color:#1a1204;">
        <img src="https://cataas.com/cat" alt="Order confirmed" style="width:100%; border-radius:12px; margin-bottom:20px;">
        <h1 style="font-size:22px;">Order Confirmed 🎉</h1>
        <p>Hi ${customerName},</p>
        <p>Your RS order <strong>#${orderId}</strong> is confirmed. Here's what's coming your way:</p>
        <table style="width:100%; border-collapse:collapse; margin:16px 0;">
          ${itemsHtml}
          ${discount > 0 ? `<tr><td style="padding:6px 0;">Member discount</td><td style="padding:6px 0; text-align:right;">−£${discount.toFixed(2)}</td></tr>` : ''}
          <tr><td style="padding:10px 0; font-weight:bold; border-top:1px solid #ddd;">Total</td><td style="padding:10px 0; font-weight:bold; text-align:right; border-top:1px solid #ddd;">£${total.toFixed(2)}</td></tr>
        </table>
        <p><strong>Shipping to:</strong><br>${address}, ${city}, ${postcode}</p>
        <p style="color:#888; font-size:12px; margin-top:24px;">This is a preview order — no payment has actually been taken yet.</p>
      </div>
    `;

    try {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "RS Member Rewards <onboarding@resend.dev>",
          to: [email],
          subject: `Order Confirmed — #${orderId}`,
          html,
        }),
      });
      if (!emailRes.ok) {
        const errBody = await emailRes.text();
        console.error("Resend email failed:", errBody);
      }
    } catch (err) {
      console.error("Resend request failed:", err);
    }
  } else {
    console.warn("RESEND_API_KEY not set — skipping confirmation email.");
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ orderId }),
  };
};
