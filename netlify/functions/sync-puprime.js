// netlify/functions/sync-puprime.js
//
// Called whenever someone sets/edits their PU Prime ID (at signup or later
// from their profile). Keeps the Airtable mirror in sync, keyed by email.
//
// Required environment variables: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME

const { upsertAirtableRecord } = require("./_lib/airtable");

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

  const email = (data.email || "").trim();
  const fullName = (data.fullName || "").trim();
  const puprimeId = (data.puprimeId || "").trim();

  if (!email) {
    return { statusCode: 422, headers: corsHeaders, body: JSON.stringify({ error: "Missing email." }) };
  }
  if (puprimeId && !/^\d{8}$/.test(puprimeId)) {
    return { statusCode: 422, headers: corsHeaders, body: JSON.stringify({ error: "PU Prime ID must be exactly 8 digits." }) };
  }

  try {
    await upsertAirtableRecord(email, {
      "Full Name": fullName,
      "PU Prime Account Number": puprimeId,
    });
    return { statusCode: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("sync-puprime error:", err);
    return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: "Could not sync to Airtable." }) };
  }
};
