// netlify/functions/create-booking.js
//
// Creates a chauffeur booking. Rush/surcharge is computed HERE, server-side,
// never trusted from the browser — otherwise a customer could fake "not rush"
// on a same-day booking to dodge the £200 fee.
//
// Required environment variables:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//   AIRTABLE_TOKEN / AIRTABLE_BASE_ID   (reads the "Drivers" table)
//   RESEND_API_KEY

const crypto = require("crypto");

const RUSH_SURCHARGE = 200;
const RUSH_WINDOW_HOURS = 24;

async function getDrivers() {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Drivers`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.records || [])
    .map(r => ({ name: r.fields["Name"], email: r.fields["Email"] }))
    .filter(d => d.name && d.email);
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

  const userId = (data.userId || "").trim();
  const customerName = (data.customerName || "").trim();
  const customerEmail = (data.customerEmail || "").trim();
  const pickupLocation = (data.pickupLocation || "").trim();
  const dropoffLocation = (data.dropoffLocation || "").trim();
  const pickupDateTime = (data.pickupDateTime || "").trim();
  const passengers = parseInt(data.passengers, 10) || 1;
  const notes = (data.notes || "").trim();

  if (!userId || !customerName || !customerEmail || !pickupLocation || !dropoffLocation || !pickupDateTime) {
    return { statusCode: 422, headers: corsHeaders, body: JSON.stringify({ error: "Missing required fields." }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    return { statusCode: 422, headers: corsHeaders, body: JSON.stringify({ error: "Enter a valid email address." }) };
  }

  const pickupDate = new Date(pickupDateTime);
  if (isNaN(pickupDate.getTime())) {
    return { statusCode: 422, headers: corsHeaders, body: JSON.stringify({ error: "Invalid pickup date/time." }) };
  }
  const hoursUntilPickup = (pickupDate.getTime() - Date.now()) / 3600000;
  if (hoursUntilPickup < 0) {
    return { statusCode: 422, headers: corsHeaders, body: JSON.stringify({ error: "Pickup time must be in the future." }) };
  }
  const isRush = hoursUntilPickup < RUSH_WINDOW_HOURS;
  const surcharge = isRush ? RUSH_SURCHARGE : 0;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "Server not configured yet." }) };
  }

  const confirmToken = crypto.randomBytes(16).toString("hex");

  let bookingId;
  try {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/chauffeur_bookings`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        user_id: userId,
        customer_name: customerName,
        customer_email: customerEmail,
        pickup_location: pickupLocation,
        dropoff_location: dropoffLocation,
        pickup_datetime: pickupDate.toISOString(),
        passengers,
        notes,
        is_rush: isRush,
        surcharge,
        status: "searching",
        confirm_token: confirmToken,
      }),
    });
    const rows = await insertRes.json();
    if (!insertRes.ok || !rows || !rows[0]) {
      console.error("Supabase booking insert failed:", rows);
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: "Could not create booking." }) };
    }
    bookingId = rows[0].id;
  } catch (err) {
    console.error("Booking insert error:", err);
    return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: "Could not create booking." }) };
  }

  // Notify every driver by email — first to click their confirm link gets the job.
  try {
    const drivers = await getDrivers();
    const host = event.headers["x-forwarded-host"] || event.headers.host;
    const proto = event.headers["x-forwarded-proto"] || "https";

    if (process.env.RESEND_API_KEY && drivers.length) {
      await Promise.all(drivers.map(driver => {
        const confirmUrl = `${proto}://${host}/.netlify/functions/confirm-booking?booking=${bookingId}&token=${confirmToken}&driver=${encodeURIComponent(driver.name)}`;
        const html = `
          <div style="font-family: Arial, sans-serif; max-width:480px; margin:0 auto;">
            <h1 style="font-size:20px;">New Chauffeur Booking${isRush ? ' — RUSH' : ''}</h1>
            <p><strong>Pickup:</strong> ${pickupLocation}<br>
            <strong>Drop-off:</strong> ${dropoffLocation}<br>
            <strong>When:</strong> ${pickupDate.toUTCString()}<br>
            <strong>Passengers:</strong> ${passengers}${notes ? `<br><strong>Notes:</strong> ${notes}` : ''}</p>
            ${isRush ? `<p style="color:#b5822f;"><strong>Rush booking — £${RUSH_SURCHARGE} surcharge applies.</strong></p>` : ''}
            <p>First driver to confirm gets this job.</p>
            <a href="${confirmUrl}" style="display:inline-block; background:#e8a33d; color:#1a1204; font-weight:bold; padding:14px 24px; border-radius:6px; text-decoration:none; margin-top:10px;">Confirm — I'll take this job</a>
          </div>
        `;
        return fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "RS Chauffeur <onboarding@resend.dev>",
            to: [driver.email],
            subject: `New Booking${isRush ? ' (RUSH)' : ''} — ${pickupLocation} → ${dropoffLocation}`,
            html,
          }),
        }).catch(err => console.error(`Driver email to ${driver.email} failed:`, err));
      }));
    } else {
      console.warn("No drivers found or RESEND_API_KEY missing — no notification sent.");
    }
  } catch (err) {
    console.error("Driver notification step failed (non-fatal):", err);
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ bookingId, isRush, surcharge }),
  };
};
