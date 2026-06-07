import { Router } from "express";
import { repo } from "../db.js";

const r = Router();

// قائمة المكاتب
r.get("/offices", async (req, res) => res.json(await repo.listOffices()));

// إنشاء مكتب جديد + حساب مشرف
r.post("/offices", async (req, res) => {
  const { officeName, supervisor } = req.body || {};
  if (!officeName || !supervisor?.username || !supervisor?.password)
    return res.status(400).json({ error: "اسم المكتب وبيانات المشرف (اسم مستخدم وكلمة مرور) مطلوبة." });
  if (await repo.usernameTaken(supervisor.username))
    return res.status(409).json({ error: "اسم المستخدم مستخدم مسبقاً." });

  const officeId = await repo.createOffice(officeName);
  const user = await repo.createUser({
    officeId, username: supervisor.username, name: supervisor.name || "مشرف المكتب",
    role: "supervisor", password: supervisor.password,
  });
  res.status(201).json({ officeId, officeName, supervisor: user });
});

// تفعيل / إيقاف مكتب
r.patch("/offices/:id", async (req, res) => {
  const off = await repo.setOfficeActive(Number(req.params.id), !!req.body.active);
  if (!off) return res.status(404).json({ error: "المكتب غير موجود" });
  res.json({ id: off.id, name: off.name, active: !!off.active });
});

// الخطط المتاحة
r.get("/plans", async (req, res) => res.json(await repo.listPlans()));

// منح/تمديد فترة تجريبية
r.post("/offices/:id/trial", async (req, res) => {
  const days = Number(req.body?.days) || 14;
  const sub = await repo.startTrial(Number(req.params.id), days);
  res.json({ ok: true, subscription: sub });
});

// إنشاء رابط سداد (Tap)
const TAP_API = "https://api.tap.company/v2";
const tapSecret = async () => (await repo.getSetting("tap_secret_key")) || process.env.TAP_SECRET_KEY || "";
const baseUrl = async (req) => (await repo.getSetting("app_url")) || process.env.APP_URL || `${req.protocol}://${req.get("host")}`;

r.post("/offices/:id/payment-link", async (req, res) => {
  const officeId = Number(req.params.id);
  const plan = await repo.getPlan(req.body?.planCode);
  if (!plan) return res.status(400).json({ error: "خطة غير معروفة" });
  const total = Math.round(plan.price * (1 + plan.vat) * 100) / 100;
  const TAP_SECRET = await tapSecret();
  if (!TAP_SECRET)
    return res.status(503).json({ error: "بوابة الدفع (Tap) غير مهيأة بعد. أضف مفتاح Tap من الإعدادات لإنشاء روابط السداد.", code: "gateway_not_configured" });
  try {
    const base = await baseUrl(req);
    const rr = await fetch(`${TAP_API}/charges`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TAP_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: total, currency: "SAR",
        description: `اشتراك ${plan.name} - الاستقدام الذكي`,
        metadata: { office_id: String(officeId), plan_code: plan.code },
        customer: { first_name: `office-${officeId}`, email: `office${officeId}@smartistiqdam.com` },
        source: { id: "src_all" },
        redirect: { url: `${base}/subscription.html` },
        post: { url: `${base}/api/subscription/tap-webhook` },
      }),
    });
    const data = await rr.json();
    const url = data?.transaction?.url;
    if (!url) return res.status(502).json({ error: "تعذّر إنشاء رابط السداد", details: data?.errors || null });
    res.json({ url, plan: plan.code, total });
  } catch (e) {
    res.status(502).json({ error: "تعذّر الاتصال ببوابة الدفع" });
  }
});

/* ===== الإعدادات ===== */
r.get("/settings", async (req, res) => {
  const s = await repo.allSettings();
  const key = (await repo.getSetting("tap_secret_key")) || "";
  res.json({
    tapKeySet: !!key,
    tapKeyMasked: key ? "•••• " + key.slice(-4) : "",
    appUrl: s.app_url || "",
    trialDays: Number(s.trial_days) || 14,
    company: await repo.companyPublic(),
    plans: await repo.listPlans(),
  });
});

r.post("/settings", async (req, res) => {
  const b = req.body || {};
  const map = {
    company_name: b.companyName, company_email: b.companyEmail, company_whatsapp: b.companyWhatsapp,
    company_phone: b.companyPhone, company_cr: b.companyCr, company_vat: b.companyVat, company_address: b.companyAddress,
    app_url: b.appUrl,
  };
  for (const [k, v] of Object.entries(map)) { if (v !== undefined) await repo.setSetting(k, String(v || "")); }
  if (b.trialDays !== undefined) await repo.setSetting("trial_days", String(Number(b.trialDays) || 14));
  res.json({ ok: true, company: await repo.companyPublic() });
});

r.post("/settings/tap-key", async (req, res) => {
  const key = String(req.body?.key || "").trim();
  if (!key) return res.status(400).json({ error: "المفتاح مطلوب" });
  await repo.setSetting("tap_secret_key", key);
  res.json({ ok: true, tapKeyMasked: "•••• " + key.slice(-4) });
});

r.patch("/plans/:code", async (req, res) => {
  const p = await repo.updatePlan(req.params.code, { price: req.body?.price, name: req.body?.name });
  if (!p) return res.status(404).json({ error: "خطة غير موجودة" });
  res.json({ ok: true, plans: await repo.listPlans() });
});

/* ===== المقالات ===== */
r.get("/articles", async (req, res) => res.json(await repo.listArticles(false)));
r.post("/articles", async (req, res) => {
  const { title } = req.body || {};
  if (!title) return res.status(400).json({ error: "العنوان مطلوب" });
  res.json(await repo.createArticle(req.body));
});
r.patch("/articles/:id", async (req, res) => {
  const a = await repo.updateArticle(Number(req.params.id), req.body || {});
  if (!a) return res.status(404).json({ error: "المقال غير موجود" });
  res.json(a);
});
r.delete("/articles/:id", async (req, res) => res.json(await repo.deleteArticle(Number(req.params.id))));

/* ===== العملاء والفواتير ===== */
r.get("/clients", async (req, res) => {
  const offices = await repo.listOffices();
  const out = await Promise.all(offices.map(async (o) => {
    const payments = await repo.listPayments(o.id);
    const paidTotal = payments.filter((p) => p.status === "paid").reduce((s, p) => s + p.total, 0);
    return { ...o, payments, paidTotal: Math.round(paidTotal * 100) / 100, invoices: await repo.listInvoices(o.id) };
  }));
  res.json(out);
});

r.post("/offices/:id/invoice", async (req, res) => {
  const officeId = Number(req.params.id);
  const plan = await repo.getPlan(req.body?.planCode);
  if (!plan) return res.status(400).json({ error: "خطة غير معروفة" });
  const vatAmount = Math.round(plan.price * plan.vat * 100) / 100;
  const total = Math.round(plan.price * (1 + plan.vat) * 100) / 100;
  const offName = ((await repo.listOffices()).find((x) => x.id === officeId) || {}).name || `مكتب ${officeId}`;
  const inv = await repo.createInvoice({ officeId, planCode: plan.code, description: `اشتراك ${plan.name}`, amount: plan.price, vat: vatAmount, total, buyerName: offName });
  res.json({ ok: true, invoice: inv });
});

r.get("/invoices", async (req, res) => res.json(await repo.listInvoices(req.query.office_id ? Number(req.query.office_id) : null)));
r.get("/invoices/:id", async (req, res) => {
  const inv = await repo.getInvoice(Number(req.params.id));
  if (!inv) return res.status(404).json({ error: "الفاتورة غير موجودة" });
  res.json({ invoice: inv, company: await repo.companyPublic() });
});

export default r;
