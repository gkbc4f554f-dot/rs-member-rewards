// netlify/functions/entry-count.js
// Powers the live "X people have entered" counter on the homepage.

exports.handler = async () => {
  const AIRTABLE_URL = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Signups")}`;
  try {
    let count = 0;
    let offset;
    let pages = 0;
    do {
      const url = offset ? `${AIRTABLE_URL}?pageSize=100&offset=${offset}` : `${AIRTABLE_URL}?pageSize=100`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } });
      if (!res.ok) break;
      const data = await res.json();
      count += (data.records || []).length;
      offset = data.offset;
      pages++;
    } while (offset && pages < 5);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ count, approx: !!offset }),
    };
  } catch (err) {
    console.error("entry-count error:", err);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 0 }) };
  }
};
