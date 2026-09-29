// netlify/functions/confirm-booking.js
//
// GET endpoint a driver opens from the email link. No login — the token in
// the URL IS the security mechanism (long, random, single-use).
//
// Required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

function page(title, message, ok) {
  return {
    statusCode: ok ? 200 : 403,
    headers: { "Content-Type": "text/html" },
    body: `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
      <style>body{font-family:sans-serif; background:#0a0a0c; color:#f3f1ea; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0;}
      .box{max-width:440px; text-align:center; padding:40px;} h1{color:${ok ? "#e8a33d" : "#e0645c"};}</style></head>
      <body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  const { booking: bookingId, token, driver } = event.queryStringParameters || {};
  if (!bookingId || !token) return page("Invalid link", "This confirmation link is missing information.", false);

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE) return page("Not configured", "The server isn't fully configured yet.", false);

  let bookingRow;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/chauffeur_bookings?id=eq.${bookingId}&select=*`, {
      headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
    });
    const rows = await res.json();
    bookingRow = rows && rows[0];
  } catch (err) {
    console.error("Supabase fetch failed:", err);
    return page("Something went wrong", "Please try again shortly.", false);
  }

  if (!bookingRow) return page("Not found", "This booking no longer exists.", false);
  if (bookingRow.confirm_token !== token) return page("Invalid link", "This confirmation link isn't valid.", false);
  if (bookingRow.status !== "searching") {
    return page("Already taken", "Another driver already confirmed this ride — thanks for checking!", false);
  }

  const driverName = driver || "A driver";
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/chauffeur_bookings?id=eq.${bookingId}`, {
      method: "PATCH",
      headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ status: "confirmed", confirmed_by: driverName }),
    });
  } catch (err) {
    console.error("Supabase update failed:", err);
    return page("Something went wrong", "Please try again shortly.", false);
  }

  if (process.env.RESEND_API_KEY && bookingRow.customer_email) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Vescair Chauffeur <onboarding@resend.dev>",
          to: bookingRow.customer_email,
          subject: "Your Vescair chauffeur is confirmed",
          html: `<div style="font-family:sans-serif; max-width:520px; margin:0 auto;">
            <h2>Your ride is confirmed</h2>
            <p><b>${driverName}</b> will pick you up at:<br>${bookingRow.pickup_location}</p>
            <p><b>Drop-off:</b> ${bookingRow.dropoff_location}<br>
            <b>When:</b> ${new Date(bookingRow.pickup_datetime).toUTCString()}</p>
          </div>`,
        }),
      });
    } catch (err) {
      console.error("Customer confirmation email failed:", err);
    }
  }

  return page("You're confirmed!", `Thanks ${driverName} — the customer has been emailed with your name. Drive safe.`, true);
};
