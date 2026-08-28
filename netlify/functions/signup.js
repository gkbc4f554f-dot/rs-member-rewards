// netlify/functions/signup.js
//
// Receives the signup form (name, email, phone, DOB, PU Prime account number),
// creates a "Pending" row in Airtable, then asks Didit to create a hosted
// verification session and returns that URL to the browser so the user can
// complete their ID scan + liveness check.
//
// Required environment variables (set these in Netlify, never in the code):
//   AIRTABLE_TOKEN        - Airtable Personal Access Token (starts with "pat")
//   AIRTABLE_BASE_ID      - starts with "app"
//   AIRTABLE_TABLE_NAME   - e.g. "Signups"
//   DIDIT_API_KEY         - from Didit Business Console > API & Webhooks
//   DIDIT_WORKFLOW_ID     - the workflow you build in the Didit console
//   DIDIT_CALLBACK_URL    - where Didit sends the user back after verifying
//                           e.g. https://your-site.netlify.app/#/verified

const AIRTABLE_URL = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Signups")}`;
const DIDIT_SESSION_URL = "https://verification.didit.me/v3/session/";

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function isValidDate(v) {
  // Expecting YYYY-MM-DD from an <input type="date">
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v).getTime());
}

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

  const fullName = (data.fullName || "").trim();
  const email = (data.email || "").trim().toLowerCase();
  const phone = (data.phone || "").trim();
  const dob = (data.dob || "").trim();
  const puprimeAccount = (data.puprimeAccount || "").trim();

  // ---- Validate everything server-side. Never trust the browser alone. ----
  const errors = {};
  if (fullName.length < 2) errors.fullName = "Enter your full name.";
  if (!isValidEmail(email)) errors.email = "Enter a valid email address.";
  if (phone.length < 6) errors.phone = "Enter a valid phone number.";
  if (!isValidDate(dob)) errors.dob = "Enter a valid date of birth.";
  if (puprimeAccount.length < 3) errors.puprimeAccount = "Enter your PU Prime account number.";

  if (Object.keys(errors).length) {
    return { statusCode: 422, headers: corsHeaders, body: JSON.stringify({ errors }) };
  }

  const requiredEnv = ["AIRTABLE_TOKEN", "AIRTABLE_BASE_ID", "DIDIT_API_KEY", "DIDIT_WORKFLOW_ID"];
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("Missing required environment variables:", missing);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "Server not configured yet." }) };
  }

  // ---- 1. Create the Airtable record (status: Pending) ----
  let recordId;
  try {
    const airtableRes = await fetch(AIRTABLE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          "Full Name": fullName,
          "Email": email,
          "Phone": phone,
          "Date of Birth": dob,
          "PU Prime Account Number": puprimeAccount,
          "Verification Status": "Pending",
          "Signup Date": new Date().toISOString(),
        },
      }),
    });

    const airtableData = await airtableRes.json();
    if (!airtableRes.ok) {
      console.error("Airtable error:", airtableData);
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: "Could not save signup. Try again shortly." }) };
    }
    recordId = airtableData.id;
  } catch (err) {
    console.error("Airtable request failed:", err);
    return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: "Could not save signup. Try again shortly." }) };
  }

  // ---- 2. Create the Didit verification session ----
  // vendor_data carries OUR record id, so the webhook can find the right
  // row again without us needing to store or look anything up by email.
  try {
    const diditRes = await fetch(DIDIT_SESSION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.DIDIT_API_KEY,
      },
      body: JSON.stringify({
        workflow_id: process.env.DIDIT_WORKFLOW_ID,
        vendor_data: recordId,
        callback: process.env.DIDIT_CALLBACK_URL || undefined,
      }),
    });

    const diditData = await diditRes.json();
    if (diditRes.status !== 201) {
      console.error("Didit error:", diditData);
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: "Could not start verification. Try again shortly." }) };
    }

    // Store the session id on the Airtable record so we can cross-reference later.
    await fetch(`${AIRTABLE_URL}/${recordId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: { "Didit Session ID": diditData.session_id } }),
    });

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
