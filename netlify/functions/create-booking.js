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
// in index.html (same ids, centers, radii, statuses). If you add/rename a
// zone, update both places. The client only draws these on the map and
// gives a live warning; this server-side copy is what actually decides
// whether a booking is allowed, computed fresh from the submitted
// coordinates — the client's own "pickupZone" guess is never trusted.
const LAGOS_ZONES = [
  { id: "ikoyi", status: "blue", center: [6.4531, 3.4352], radius: 1800 },
  { id: "victoria-island", status: "blue", center: [6.4281, 3.4219], radius: 2200 },
  { id: "lekki-phase-1", status: "blue", center: [6.4406, 3.4734], radius: 2000 },
  { id: "ikeja-gra", status: "blue", center: [6.5793, 3.3556], radius: 1800 },
  { id: "ajah", status: "purple", center: [6.4698, 3.5852], radius: 3000 },
  { id: "yaba", status: "purple", center: [6.5147, 3.3708], radius: 1500 },
  { id: "magodo", status: "purple", center: [6.6083, 3.3853], radius: 1800 },
  { id: "surulere", status: "red", center: [6.4924, 3.3452], radius: 1800 },
  { id: "apapa", status: "red", center: [6.4491, 3.3592], radius: 1800 },
  { id: "oshodi", status: "red", center: [6.5560, 3.3087], radius: 1800 },
];

// Great-circle distance in meters — same formula as the client's
// haversineMeters, so zone membership matches what the customer saw drawn
// on their map.
function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function zoneForPoint(lat, lng) {
  for (const zone of LAGOS_ZONES) {
    if (haversineMeters(zone.center, [lat, lng]) <= zone.radius) return zone;
  }
  return null;
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

  const {
    userId, customerName, customerEmail, pickupLocation, dropoffLocation,
    pickupDateTime, passengers, notes,
    pickupLat, pickupLng, dropoffLat, dropoffLng,
  } = data;
  // New preference fields: trimmed, length-capped, and HTML-escaped before
  // they are ever put in an email.
  const clean = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "") || null;
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  const mood = clean(data.mood, 40);
  const vehicleBrand = clean(data.vehicleBrand, 60);
  const vehicleModel = clean(data.vehicleModel, 80);
  const tempNum = Number(data.temperature);
  const temperature = Number.isFinite(tempNum) && tempNum >= 10 && tempNum <= 30 ? tempNum : null;
  const prefLines = [
    vehicleBrand || vehicleModel ? `<b>Car wanted:</b> ${esc([vehicleBrand, vehicleModel].filter(Boolean).join(" "))}` : "",
    mood ? `<b>Mood:</b> ${esc(mood)}` : "",
    temperature !== null ? `<b>Cabin temperature:</b> ${temperature}°C` : "",
  ].filter(Boolean).map(l => `<br>${l}`).join("");
  // Passengers are capped at 5 (re-checked here, never trusting the browser).
  const paxCount = Math.min(5, Math.max(1, parseInt(passengers, 10) || 1));
  const city = VALID_CITIES.includes(data.city) ? data.city : "london";

  if (
    !userId || !customerName || !customerEmail || !pickupLocation || !dropoffLocation || !pickupDateTime ||
    typeof pickupLat !== "number" || typeof pickupLng !== "number" ||
    typeof dropoffLat !== "number" || typeof dropoffLng !== "number"
  ) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Missing required fields — drop a pickup and drop-off pin on the map." }) };
  }
  if (
    pickupLat < -90 || pickupLat > 90 || pickupLng < -180 || pickupLng > 180 ||
    dropoffLat < -90 || dropoffLat > 90 || dropoffLng < -180 || dropoffLng > 180
  ) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Invalid pickup/drop-off location." }) };
  }

  // ---- Lagos pickup-zone eligibility (server-authoritative) ----
  // Recomputed here from the submitted coordinates — the client's own
  // "pickupZone" guess (used only for its live on-map warning) is ignored.
  let pickupZone = null;
  if (city === "lagos") {
    const zone = zoneForPoint(pickupLat, pickupLng);
    if (!zone) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Drop the pickup pin inside a highlighted zone." }) };
    }
    if (zone.status === "red") {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Pickup isn't available in that zone. Choose a blue or purple zone, or pick a different city." }) };
    }
    // "blue" or "purple" -> allowed (purple just carries a warning client-side)
    pickupZone = zone.id;
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
        pickup_lat: pickupLat, pickup_lng: pickupLng,
        dropoff_lat: dropoffLat, dropoff_lng: dropoffLng,
        pickup_datetime: pickupDate.toISOString(), passengers: paxCount,
        notes: notes || null, city, pickup_zone: pickupZone,
        mood, temperature, vehicle_brand: vehicleBrand, vehicle_model: vehicleModel,
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
                <b>Passengers:</b> ${paxCount}${prefLines}${isRush ? `<br><b>Rush fee applies:</b> £${RUSH_SURCHARGE}` : ""}</p>
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
