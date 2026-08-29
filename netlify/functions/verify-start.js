// netlify/functions/verify-start.js
//
// Called from the profile page / verification popup when a logged-in user
// clicks "Verify Account". Creates a Didit session tied to their Supabase
// user id (not an Airtable record — accounts live in Supabase now).
//
// Required environment variables:
//   DIDIT_API_KEY
//   DIDIT_WORKFLOW_ID
//   DIDIT_CALLBACK_URL

const { upsertAirtableRecord } = require("./_lib/airtable");

const DIDIT_SESSION_URL = "https://verification.didit.me/v3/session/";

exports.handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const userId = (data.userId || "").trim();
  const email = (data.email || "").trim();
  if (!userId) {
    return { statusCode: 422, headers: corsHeaders, body: JSON.stringify({ error: "Missing user id." }) };
  }

  const requiredEnv = ["DIDIT_API_KEY", "DIDIT_WORKFLOW_ID"];
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("Missing required environment variables:", missing);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "Server not configured yet." }) };
  }

  if (email) {
    try {
      await upsertAirtableRecord(email, {});
    } catch (err) {
      console.error("Airtable ensure-row failed (non-fatal):", err);
    }
  }

  try {
    const diditRes = await fetch(DIDIT_SESSION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.DIDIT_API_KEY,
      },
      body: JSON.stringify({
        workflow_id: process.env.DIDIT_WORKFLOW_ID,
        vendor_data: userId,
        callback: process.env.DIDIT_CALLBACK_URL || undefined,
      }),
    });

    const diditData = await diditRes.json();
    if (diditRes.status !== 201) {
      console.error("Didit error:", diditData);
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: "Could not start verification. Try again shortly." }) };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ verificationUrl: diditData.url }),
    };
  } catch (err) {
    console.error("Didit request failed:", err);
    return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: "Could not start verification. Try again shortly." }) };
  }
};
