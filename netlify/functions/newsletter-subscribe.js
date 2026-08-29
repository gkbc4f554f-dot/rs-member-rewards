// netlify/functions/newsletter-subscribe.js
// Saves newsletter signups to a dedicated Airtable table called "Newsletter"
// (separate from the Signups table — these may not have RS accounts at all).
//
// Required environment variables: AIRTABLE_TOKEN, AIRTABLE_BASE_ID

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

  const email = (data.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 422, headers: corsHeaders, body: JSON.stringify({ error: "Enter a valid email address." }) };
  }

  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Newsletter`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { Email: email, "Subscribed Date": new Date().toISOString() } }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error("Airtable newsletter write failed:", errBody);
      // Don't fail the request over this — the person still gets their popup success state.
    }
    return { statusCode: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("newsletter-subscribe error:", err);
    return { statusCode: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  }
};
