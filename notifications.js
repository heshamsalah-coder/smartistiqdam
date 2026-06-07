// خدمة إشعارات حقيقية — تتبدّل حسب المزوّد في .env
// console (تطوير) | twilio (WhatsApp/SMS) | unifonic (مزوّد سعودي)

// تحويل 05xxxxxxxx إلى صيغة دولية +9665xxxxxxxx
function intlPhone(phone) {
  let p = String(phone || "").replace(/[\s-]/g, "");
  if (p.startsWith("+")) return p;
  if (p.startsWith("00")) return "+" + p.slice(2);
  if (p.startsWith("05")) return "+966" + p.slice(1);
  if (p.startsWith("5") && p.length === 9) return "+966" + p;
  if (p.startsWith("966")) return "+" + p;
  return p;
}

async function sendTwilio(phone, message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  const channel = process.env.TWILIO_CHANNEL || "whatsapp";
  if (!sid || !token || !from) throw new Error("Twilio credentials missing");
  const to = channel === "whatsapp" ? `whatsapp:${intlPhone(phone)}` : intlPhone(phone);
  const body = new URLSearchParams({ From: from, To: to, Body: message });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
  return { provider: "twilio", channel };
}

async function sendUnifonic(phone, message) {
  const appSid = process.env.UNIFONIC_APPSID;
  if (!appSid) throw new Error("Unifonic AppSid missing");
  const body = new URLSearchParams({
    AppSid: appSid,
    Recipient: intlPhone(phone).replace("+", ""),
    Body: message,
  });
  if (process.env.UNIFONIC_SENDER) body.set("SenderID", process.env.UNIFONIC_SENDER);
  const res = await fetch("https://el.cloud.unifonic.com/rest/SMS/messages", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Unifonic ${res.status}: ${await res.text()}`);
  return { provider: "unifonic", channel: "SMS" };
}

export async function sendNotification(phone, message) {
  const provider = process.env.NOTIFY_PROVIDER || "console";
  try {
    if (provider === "twilio") { const r = await sendTwilio(phone, message); return { status: "sent", ...r }; }
    if (provider === "unifonic") { const r = await sendUnifonic(phone, message); return { status: "sent", ...r }; }
    console.log(`[NOTIFY:console] → ${intlPhone(phone)} :: ${message}`);
    return { status: "sent", provider: "console", channel: "console" };
  } catch (e) {
    console.error("notify error:", e.message);
    return { status: "failed", provider, channel: provider, error: e.message };
  }
}
