// netlify/functions/didit-webhook.js
//
// Didit calls this URL every time a verification session's status changes.
// We check the signature (so nobody can fake a "verified" result), then
// update the matching Airtable row.
//
// Set this exact URL as your Webhook URL in the Didit Business Console:
//   https://YOUR-SITE.netlify.app/.netlify/functions/didit-webhook
//
// Required environment variables:
//   WEBHOOK_SECRET_KEY   - shown once in the Didit console when you add the webhook
//   AIRTABLE_TOKEN
//   AIRTABLE_BASE_ID
//   AIRTABLE_TABLE_NAME

const crypto = require("crypto");

const AIRTABLE_URL = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Signups")}`;

function verifySignature(rawBody, signature, timestamp, secret) {
  if (!signature || !timestamp || !secret) return false;

  const now = Math.floor(Date.now() / 1000);
  const incoming = parseInt(timestamp, 10);
  if (!incoming || Math.abs(now - incoming) > 300) return false; // reject anything older than 5 min (replay protection)

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// Airtable's "Verification Status" single-select field should have these
// exact options: Pending, Approved, Declined, In Review, Abandoned, Not Started
function mapStatus(diditStatus) {
  const known = ["Approved", "Declined", "In Review", "Abandoned", "Not Started", "In Progress"];
  return known.includes(diditStatus) ? diditStatus : "Pending";
}

async function findRecordByVendorData(vendorData) {
  // vendor_data is the Airtable record id we handed Didit at signup time,
  // so we can fetch it directly instead of searching.
  const res = await fetch(`${AIRTABLE_URL}/${vendorData}`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
  });
  if (!res.ok) return null;
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ message: "Method not allowed" }) };
  }

  const rawBody = event.body || "";
  const signature = event.headers["x-signature"] || event.headers["X-Signature"];
  const timestamp = event.headers["x-timestamp"] || event.headers["X-Timestamp"];

  const valid = verifySignature(rawBody, signature, timestamp, process.env.WEBHOOK_SECRET_KEY);
  if (!valid) {
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
    // Nothing we can match this to — acknowledge so Didit doesn't retry forever.
    console.warn("Webhook had no vendor_data, session:", session_id);
    return { statusCode: 200, body: JSON.stringify({ message: "Acknowledged, no vendor_data" }) };
  }

  const record = await findRecordByVendorData(vendor_data);
  if (!record) {
    console.warn("No Airtable record found for vendor_data:", vendor_data);
    return { statusCode: 200, body: JSON.stringify({ message: "Acknowledged, record not found" }) };
  }

  const fields = {
    "Verification Status": mapStatus(status),
    "Didit Session ID": session_id,
  };

  // When Didit finishes a full decision, cross-check the ID document against
  // what the person typed at signup. This is the actual fraud check — it
  // catches someone verifying with their OWN id but typing a DIFFERENT
  // person's name/PU Prime account into the form.
  if (decision && decision.id_verification) {
    const idv = decision.id_verification;
    fields["Verified Full Name (from ID)"] = idv.full_name || "";
    fields["Verified Date of Birth (from ID)"] = idv.date_of_birth || "";
    fields["ID Document Status"] = idv.status || "";

    const typedName = (record.fields["Full Name"] || "").trim().toLowerCase();
    const verifiedName = (idv.full_name || "").trim().toLowerCase();
    const typedDob = (record.fields["Date of Birth"] || "").trim();
    const verifiedDob = (idv.date_of_birth || "").trim();

    const nameMatches = typedName && verifiedName && typedName === verifiedName;
    const dobMatches = typedDob && verifiedDob && typedDob === verifiedDob;
    fields["Name Matches ID"] = nameMatches;
    fields["DOB Matches ID"] = dobMatches;

    // If the document itself was approved but the typed details don't match,
    // flag it for a human to check rather than auto-approving.
    if (idv.status === "Approved" && (!nameMatches || !dobMatches)) {
      fields["Verification Status"] = "In Review";
      fields["Review Reason"] = "ID verified, but typed name/DOB does not match the document. Check before paying out.";
    }
  }

  try {
    const patchRes = await fetch(`${AIRTABLE_URL}/${vendor_data}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    });
    if (!patchRes.ok) {
      const errBody = await patchRes.text();
      console.error("Failed to update Airtable record:", errBody);
      // Still return 200 — Didit doesn't need to retry just because our
      // database write failed; that's on us to notice via logs.
    }
  } catch (err) {
    console.error("Airtable update failed:", err);
  }

  return { statusCode: 200, body: JSON.stringify({ message: "Webhook processed" }) };
};
