// netlify/functions/admin-pick-winner.js
// Password-gated. Picks a random verified (approved) entrant.

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

  if (!process.env.ADMIN_PASSWORD || data.password !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: "Incorrect password." }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "Server not configured yet." }) };
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?select=full_name,email,puprime_id&verification_status=eq.approved`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } }
    );
    const rows = await res.json();
    if (!rows || !rows.length) {
      return { statusCode: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ error: "No approved entrants yet." }) };
    }
    const pick = rows[Math.floor(Math.random() * rows.length)];
    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ winner: { fullName: pick.full_name, email: pick.email, puprimeId: pick.puprime_id } }),
    };
  } catch (err) {
    console.error("admin-pick-winner error:", err);
    return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: "Could not pick a winner." }) };
  }
};
