import { Router } from "express";
import { repo } from "../db.js";

const router = Router();
const TAP_API = "https://api.tap.company/v2";
const tapSecret = async () => (await repo.getSetting("tap_secret_key")) || process.env.TAP_SECRET_KEY || "";
const baseUrl = async (req) => (await repo.getSetting("app_url")) || process.env.APP_URL || `${req.protocol}://${req.get("host")}`;

// حالة الاشتراك + الخطط + سجل المدفوعات
router.get("/", async (req, res) => {
  res.json({
    subscription: await repo.getSubscription(req.user.office),
    plans: await repo.listPlans(),
    payments: await repo.listPayments(req.user.office),
    gatewayReady: !!(await tapSecret()),
  });
});

// بدء عملية دفع عبر Tap
router.post("/checkout", async (req, res) => {
  const plan = await repo.getPlan(req.body?.planCode);
  if (!plan) return res.status(400).json({ error: "خطة غير معروفة" });
  const total = Math.round(plan.price * (1 + plan.vat) * 100) / 100;

  const TAP_SECRET = await tapSecret();
  if (!TAP_SECRET) {
    return res.status(503).json({
      error: "بوابة الدفع (Tap) غير مهيأة بعد. أضف مفتاح Tap من الإعدادات، أو اطلب تفعيلاً يدوياً من مدير المنصة.",
      code: "gateway_not_configured",
    });
  }
  try {
    const base = await baseUrl(req);
    const r = await fetch(`${TAP_API}/charges`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TAP_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: total,
        currency: "SAR",
        description: `اشتراك ${plan.name} - الاستقدام الذكي`,
        metadata: { office_id: String(req.user.office), plan_code: plan.code },
        customer: { first_name: `office-${req.user.office}`, email: `office${req.user.office}@smartistiqdam.com` },
        source: { id: "src_all" },
        redirect: { url: `${base}/subscription.html` },
        post: { url: `${base}/api/subscription/tap-webhook` },
      }),
    });
    const data = await r.json();
    const url = data?.transaction?.url;
    if (!url) return res.status(502).json({ error: "تعذّر إنشاء عملية الدفع", details: data?.errors || null });
    res.json({ url });
  } catch (e) {
    res.status(502).json({ error: "تعذّر الاتصال ببوابة الدفع" });
  }
});

// التحقق من الدفع بعد عودة العميل من Tap
router.get("/verify", async (req, res) => {
  const tapId = req.query.tap_id;
  if (!tapId) return res.status(400).json({ error: "معرّف العملية مفقود" });
  const TAP_SECRET = await tapSecret();
  if (!TAP_SECRET) return res.status(503).json({ error: "بوابة الدفع غير مهيأة" });
  try {
    const r = await fetch(`${TAP_API}/charges/${tapId}`, { headers: { Authorization: `Bearer ${TAP_SECRET}` } });
    const c = await r.json();
    const officeId = Number(c?.metadata?.office_id);
    const planCode = c?.metadata?.plan_code;
    if (officeId !== req.user.office) return res.status(403).json({ error: "عملية لا تخص هذا المكتب" });
    if (c?.status !== "CAPTURED") return res.json({ paid: false, status: c?.status || "UNKNOWN" });
    const plan = await repo.getPlan(planCode);
    const vatAmount = Math.round(plan.price * plan.vat * 100) / 100;
    await repo.recordPayment(officeId, planCode, plan.price, vatAmount, c.amount, "paid", "tap", c.id);
    await repo.activatePlan(officeId, planCode);
    const offName = ((await repo.listOffices()).find((x) => x.id === officeId) || {}).name || ("مكتب " + officeId);
    await repo.createInvoice({ officeId, planCode, description: `اشتراك ${plan.name}`, amount: plan.price, vat: vatAmount, total: c.amount, buyerName: offName });
    res.json({ paid: true, subscription: await repo.getSubscription(officeId) });
  } catch (e) {
    res.status(502).json({ error: "تعذّر التحقق من الدفع" });
  }
});

// Webhook من Tap (تأكيد خلفي)
router.post("/tap-webhook", async (req, res) => {
  try {
    const id = req.body?.id;
    const TAP_SECRET = await tapSecret();
    if (id && TAP_SECRET) {
      const r = await fetch(`${TAP_API}/charges/${id}`, { headers: { Authorization: `Bearer ${TAP_SECRET}` } });
      const c = await r.json();
      if (c?.status === "CAPTURED") {
        const officeId = Number(c?.metadata?.office_id);
        const planCode = c?.metadata?.plan_code;
        const plan = await repo.getPlan(planCode);
        if (officeId && plan) {
          const vatAmount = Math.round(plan.price * plan.vat * 100) / 100;
          await repo.recordPayment(officeId, planCode, plan.price, vatAmount, c.amount, "paid", "tap", c.id);
          await repo.activatePlan(officeId, planCode);
          const offName = ((await repo.listOffices()).find((x) => x.id === officeId) || {}).name || ("مكتب " + officeId);
          await repo.createInvoice({ officeId, planCode, description: `اشتراك ${plan.name}`, amount: plan.price, vat: vatAmount, total: c.amount, buyerName: offName });
        }
      }
    }
  } catch {}
  res.json({ ok: true });
});

export default router;
