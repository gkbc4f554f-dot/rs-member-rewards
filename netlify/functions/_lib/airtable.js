// netlify/functions/_lib/airtable.js
// Shared by several functions — keeps Airtable as a synced mirror of Supabase,
// keyed by email, so the user can view/manage entrants as a real spreadsheet.
// Also used to pull the driver roster for chauffeur bookings.

function tableUrl(tableName) {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`;
}

function airtableUrl() {
  return tableUrl(process.env.AIRTABLE_TABLE_NAME || "Signups");
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

// Driver roster lives in its own Airtable table (default name "Drivers"),
// with at minimum "Name" and "Email" columns. Add more drivers by adding
// rows there directly — no code change needed.
async function getDrivers() {
  const tableName = process.env.AIRTABLE_DRIVERS_TABLE || "Drivers";
  const res = await fetch(tableUrl(tableName), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` },
  });
  if (!res.ok) throw new Error("Airtable drivers fetch failed: " + (await res.text()));
  const data = await res.json();
  return (data.records || [])
    .map(r => ({ name: r.fields.Name, email: r.fields.Email, city: r.fields.City || null }))
    .filter(d => d.name && d.email);
}

module.exports = { findRecordByEmail, upsertAirtableRecord, getDrivers };
