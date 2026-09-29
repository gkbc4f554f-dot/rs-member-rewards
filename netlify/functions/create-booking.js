// netlify/functions/create-booking.js
//
// Creates a chauffeur booking. Every business rule that affects money or
// eligibility is decided HERE, never trusting what the client sent:
//   - the £200 rush surcharge (client shows a preview, this recalculates it)
//   - the Lagos pickup-zone restriction (client shows a map, this re-checks it)
// London and Dubai have no pickup restriction, same as before.
//
// Required environment variables:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_DRIVERS_TABLE (default "Drivers")
//   RESEND_API_KEY

const crypto = require("crypto");
const { getDrivers } = require("./_lib/airtable");

const RUSH_SURCHARGE = 200;
const RUSH_WINDOW_HOURS = 24;

const VALID_CITIES = ["london", "lagos", "dubai"];

// Authoritative copy of the Lagos zone list — must match the client's list
// in index.html. If you add/rename a zone, update both places.
const LAGOS_ZONES = {
  "ikoyi": "blue",
  "victoria-island": "blue",
  "lekki-phase-1": "blue",
  "ikeja-gra": "blue",
  "ajah": "purple",
  "yaba": "purple",
  "magodo": "purple",
  "surulere": "red",
  "apapa": "red",
  "oshodi": "red",
};

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

  const {
    userId, customerName, customerEmail, pickupLocation, dropoffLocation,
    pickupDateTime, passengers, notes,
  } = data;
  const city = VALID_CITIES.includes(data.city) ? data.city : "london";

  if (!userId || !customerName || !customerEmail || !pickupLocation || !dropoffLocation || !pickupDateTime) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Missing required fields." }) };
  }

  // ---- Lagos pickup-zone eligibility (server-authoritative) ----
  let pickupZone = null;
  if (city === "lagos") {
    pickupZone = data.pickupZone;
    const status = pickupZone ? LAGOS_ZONES[pickupZone] : undefined;
    if (!status) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Select a valid pickup zone for Lagos." }) };
    }
    if (status === "red") {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Pickup isn't available in that zone. Choose a blue or purple zone, or pick a different city." }) };
    }
    // status === "blue" or "purple" -> allowed (purple just carries a warning client-side)
  }

  // ---- rush surcharge (server-authoritative) ----
  const pickupDate = new Date(pickupDateTime);
  if (isNaN(pickupDate.getTime()) || pickupDate.getTime() <= Date.now()) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Pickup date/time must be in the future." }) };
  }
  const hoursUntil = (pickupDate.getTime() - Date.now()) / 3600000;
  const isRush = hoursUntil < RUSH_WINDOW_HOURS;
  const rushFee = isRush ? RUSH_SURCHARGE : 0;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "Server not configured yet." }) };
  }

  const confirmToken = crypto.randomBytes(16).toString("hex");

  let bookingRow;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/chauffeur_bookings`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json", Prefer: "return=representation",
      },
      body: JSON.stringify({
        user_id: userId, customer_name: customerName, customer_email: customerEmail,
        pickup_location: pickupLocation, dropoff_location: dropoffLocation,
        pickup_datetime: pickupDate.toISOString(), passengers: passengers || 1,
        notes: notes || null, city, pickup_zone: pickupZone,
        is_rush: isRush, rush_fee: rushFee, status: "searching", confirm_token: confirmToken,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const rows = await res.json();
    bookingRow = rows[0];
  } catch (err) {
    console.error("Supabase booking insert failed:", err);
    return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: "Could not create booking — try again." }) };
  }

  // ---- notify drivers for this city (drivers with no City set are treated as available everywhere) ----
  try {
    const allDrivers = await getDrivers();
    const cityLabel = { london: "London", lagos: "Lagos", dubai: "Dubai" }[city];
    const drivers = allDrivers.filter(d => !d.city || d.city.toLowerCase() === city || d.city.toLowerCase() === cityLabel.toLowerCase());
    const proto = event.headers["x-forwarded-proto"] || "https";
    const host = event.headers.host;

    if (drivers.length && process.env.RESEND_API_KEY) {
      await Promise.all(drivers.map(driver => {
        const confirmUrl = `${proto}://${host}/.netlify/functions/confirm-booking?booking=${bookingRow.id}&token=${confirmToken}&driver=${encodeURIComponent(driver.name)}`;
        return fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Vescair Chauffeur <onboarding@resend.dev>",
            to: driver.email,
            subject: `New ${cityLabel} ride request${isRush ? " — RUSH" : ""}`,
            html: `
              <div style="font-family:sans-serif; max-width:520px; margin:0 auto;">
                <h2>New chauffeur request — ${cityLabel}</h2>
                <p><b>Pickup:</b> ${pickupLocation}${pickupZone ? ` (zone: ${pickupZone})` : ""}<br>
                <b>Drop-off:</b> ${dropoffLocation}<br>
                <b>When:</b> ${pickupDate.toUTCString()}<br>
                <b>Passengers:</b> ${passengers || 1}${isRush ? `<br><b>Rush fee applies:</b> £${RUSH_SURCHARGE}` : ""}</p>
                <p><a href="${confirmUrl}" style="background:#e8a33d; color:#1a1204; font-weight:800; padding:12px 22px; border-radius:999px; text-decoration:none; display:inline-block;">Accept this ride</a></p>
                <p style="color:#888; font-size:13px;">First driver to accept gets it — this link stops working once someone else confirms.</p>
              </div>`,
          }),
        }).catch(err => console.error("Driver email failed for", driver.email, err));
      }));
    } else if (!drivers.length) {
      console.warn(`No drivers on file for city "${city}" — booking ${bookingRow.id} created but nobody was notified.`);
    }
  } catch (err) {
    console.error("Driver notification step failed (booking still created):", err);
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ bookingId: bookingRow.id, isRush, rushFee }),
  };
};
