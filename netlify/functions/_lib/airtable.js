// netlify/functions/_lib/airtable.js
// Shared by several functions — keeps Airtable as a synced mirror of Supabase,
// keyed by email, so the user can view/manage entrants as a real spreadsheet.

function airtableUrl() {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Signups")}`;
}

async function findRecordByEmail(email) {
  const formula = encodeURIComponent(`{Email}="${email.replace(/"/g, '\\"')}"`);
  const res = await fetch(`${airtableUrl()}?filterByFormula=${formula}&maxRecords=1`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return (data.records && data.records[0]) || null;
}

async function upsertAirtableRecord(email, fields) {
  const existing = await findRecordByEmail(email);
  if (existing) {
    const res = await fetch(`${airtableUrl()}/${existing.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) throw new Error("Airtable PATCH failed: " + (await res.text()));
    return res.json();
  } else {
    const res = await fetch(airtableUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: { Email: email, ...fields } }),
    });
    if (!res.ok) throw new Error("Airtable POST failed: " + (await res.text()));
    return res.json();
  }
}

module.exports = { findRecordByEmail, upsertAirtableRecord };
