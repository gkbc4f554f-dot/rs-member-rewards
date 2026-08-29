// netlify/functions/didit-webhook.js 
//
// Didit calls this every time a verification session's status changes.
// vendor_data is the Supabase user id we sent when the session was created.
//
// Required environment variables:
//   WEBHOOK_SECRET_KEY          - from the Didit console when you registered this webhook
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   - server-only, bypasses RLS so we can write verification results
//   AIRTABLE_TOKEN / AIRTABLE_BASE_ID / AIRTABLE_TABLE_NAME

const crypto = require("crypto");
const { upsertAirtableRecord } = require("./_lib/airtable");

// ---- Didit's official X-Signature-V2 canonicalisation ----
function shortenFloats(v) {
  if (Array.isArray(v)) return v.map(shortenFloats);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shortenFloats(x)]));
  }
  if (typeof v === "number" && !Number.isInteger(v) && v % 1 === 0) return Math.trunc(v);
  return v;
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = sortKeys(v[k]); return acc; }, {});
  }
  return v;
}
function verifySignatureV2(rawBody, signature, timestamp, secret) {
  if (!signature || !timestamp || !secret) return false;
  const now = Math.floor(Date.now() / 1000);
  const incoming = parseInt(timestamp, 10);
  if (!incoming || Math.abs(now - incoming) > 300) return false; // 5 min replay window
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { return false; }
  const canonical = JSON.stringify(sortKeys(shortenFloats(parsed)));
  const expected = crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// Supabase profiles.verification_status — our own simplified vocabulary
function mapSupabaseStatus(diditStatus) {
  const map = {
    "Approved": "approved", "Declined": "declined", "In Review": "in_review",
    "Not Started": "not_started", "Abandoned": "not_started", "Expired": "not_started",
    "Kyc Expired": "not_started", "In Progress": "pending", "Awaiting User": "pending",
    "Resubmitted": "pending",
  };
  return map[diditStatus] || "pending";
}

// Airtable's "Verification Status" single-select only has these 6 exact options —
// mapping every possible Didit status onto one of them avoids the
// INVALID_MULTIPLE_CHOICE_OPTIONS error we hit earlier.
function mapAirtableStatus(diditStatus) {
  const map = {
    "Approved": "Approved", "Declined": "Declined", "In Review": "In Review",
    "Abandoned": "Abandoned", "Not Started": "Not Started",
    "In Progress": "Pending", "Awaiting User": "Pending", "Resubmitted": "Pending",
    "Expired": "Abandoned", "Kyc Expired": "Not Started",
  };
  return map[diditStatus] || "Pending";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ message: "Method not allowed" }) };
  }

  const rawBody = event.body || "";
  const signature = event.headers["x-signature-v2"] || event.headers["X-Signature-V2"];
  const timestamp = event.headers["x-timestamp"] || event.headers["X-Timestamp"];

  if (!verifySignatureV2(rawBody, signature, timestamp, process.env.WEBHOOK_SECRET_KEY)) {
    console.error("Webhook signature verification failed");
    return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ message: "Invalid JSON" }) };
  }

  const { session_id, status, vendor_data, decision } = body;
  if (!vendor_data) {
    console.warn("Webhook had no vendor_data, session:", session_id);
    return { statusCode: 200, body: JSON.stringify({ message: "Acknowledged, no vendor_data" }) };
  }

  const userId = vendor_data; // Supabase auth user id
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_ROLE) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — cannot process webhook");
    return { statusCode: 200, body: JSON.stringify({ message: "Acknowledged, server not fully configured" }) };
  }

  // Fetch the profile so we can cross-check the name and get the email for Airtable.
  let profile = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=*`, {
      headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
    });
    const rows = await res.json();
    profile = rows && rows[0];
  } catch (err) {
    console.error("Supabase profile fetch failed:", err);
  }

  let supabaseStatus = mapSupabaseStatus(status);

  // Fraud check: if the ID was approved but the name on it doesn't match what
  // they typed at signup, don't auto-approve — flag it for a human to check.
  if (decision && decision.id_verifications && decision.id_verifications.length) {
    const idv = decision.id_verifications[0];
    const typedName = ((profile && profile.full_name) || "").trim().toLowerCase();
    const verifiedName = `${idv.first_name || ""} ${idv.last_name || ""}`.trim().toLowerCase();
    const nameMatches = typedName && verifiedName && typedName === verifiedName;
    if (idv.status === "Approved" && supabaseStatus === "approved" && !nameMatches) {
      supabaseStatus = "in_review";
    }
  }

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
      method: "PATCH",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ verification_status: supabaseStatus, didit_session_id: session_id }),
    });
  } catch (err) {
    console.error("Supabase profile update failed:", err);
  }

  if (profile && profile.email) {
    try {
      await upsertAirtableRecord(profile.email, {
        "Full Name": profile.full_name || "",
        "PU Prime Account Number": profile.puprime_id || "",
        "Verification Status": mapAirtableStatus(status),
      });
    } catch (err) {
      console.error("Airtable sync failed:", err);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ message: "Webhook processed" }) };
};
