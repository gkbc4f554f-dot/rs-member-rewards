// netlify/functions/confirm-booking.js
//
// A driver clicks this link straight from their email — no login, no app,
// just a secure token in the URL. First driver to click wins the job;
// everyone else who clicks after sees "already taken."
//
// Required environment variables:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY

function htmlPage(title, message, ok) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body{ font-family: -apple-system, Arial, sans-serif; background:#0a0a0c; color:#f3f1ea; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:24px; }
  .card{ max-width:420px; text-align:center; }
  h1{ font-size:22px; margin-bottom:12px; color:${ok ? '#e8a33d' : '#f28b85'}; }
  p{ color:#9a99a1; line-height:1.6; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: { "Content-Type": "text/html" }, body: htmlPage("Method not allowed", "", false) };
  }

  const { booking, token, driver } = event.queryStringParameters || {};
  if (!booking || !token || !driver) {
    return { statusCode: 400, headers: { "Content-Type": "text/html" }, body: htmlPage("Invalid link", "This confirmation link is missing information.", false) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return { statusCode: 500, headers: { "Content-Type": "text/html" }, body: htmlPage("Server not ready", "Please try again shortly.", false) };
  }

  let bookingRow;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/chauffeur_bookings?id=eq.${booking}&select=*`, {
      headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
    });
    const rows = await res.json();
    bookingRow = rows && rows[0];
  } catch (err) {
    console.error("Booking lookup failed:", err);
  }

  if (!bookingRow) {
    return { statusCode: 404, headers: { "Content-Type": "text/html" }, body: htmlPage("Booking not found", "This booking may have been removed.", false) };
  }
  if (bookingRow.confirm_token !== token) {
    return { statusCode: 403, headers: { "Content-Type": "text/html" }, body: htmlPage("Invalid link", "This confirmation link doesn't match any booking.", false) };
  }
  if (bookingRow.status !== "searching") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html" },
      body: htmlPage("Already taken", `This job was already confirmed${bookingRow.confirmed_by ? ` by ${bookingRow.confirmed_by}` : ''}. Nothing more to do here.`, false),
    };
  }

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/chauffeur_bookings?id=eq.${booking}`, {
      method: "PATCH",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ status: "confirmed", confirmed_by: driver }),
    });
  } catch (err) {
    console.error("Booking confirm update failed:", err);
    return { statusCode: 502, headers: { "Content-Type": "text/html" }, body: htmlPage("Something went wrong", "Please try again.", false) };
  }

  // Notify the customer their driver is confirmed.
  if (process.env.RESEND_API_KEY && bookingRow.customer_email) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "RS Chauffeur <onboarding@resend.dev>",
          to: [bookingRow.customer_email],
          subject: "Your chauffeur is confirmed",
          html: `<div style="font-family: Arial, sans-serif; max-width:480px; margin:0 auto;">
            <h1 style="font-size:20px;">Driver Confirmed 🚗</h1>
            <p>${driver} will pick you up at <strong>${bookingRow.pickup_location}</strong> and take you to <strong>${bookingRow.dropoff_location}</strong>.</p>
            <p><strong>Pickup time:</strong> ${new Date(bookingRow.pickup_datetime).toUTCString()}</p>
          </div>`,
        }),
      });
    } catch (err) {
      console.error("Customer confirmation email failed (non-fatal):", err);
    }
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html" },
    body: htmlPage("You're confirmed!", `Thanks ${driver} — you've got this job. The customer has been notified.`, true),
  };
};
