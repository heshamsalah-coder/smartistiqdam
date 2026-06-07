import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) process.env[m[1]] ??= m[2];
  }
}

const { login, requireAuth, requirePermission, requireSuperAdmin, requireOffice, requireActiveSubscription } = await import("./auth.js");
const { initDb } = await import("./db.js");
const { ROLE_LABELS } = await import("./security.js");
const ordersR = (await import("./routes/orders.js")).default;
const documentsR = (await import("./routes/documents.js")).default;
const dashboardR = (await import("./routes/dashboard.js")).default;
const publicR = (await import("./routes/public.js")).default;
const adminR = (await import("./routes/admin.js")).default;
const usersR = (await import("./routes/users.js")).default;
const workersR = (await import("./routes/workers.js")).default;
const subscriptionR = (await import("./routes/subscription.js")).default;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public"), { index: "landing.html" }));

app.get("/api/health", (req, res) => res.json({ ok: true, provider: process.env.NOTIFY_PROVIDER || "console" }));

// تسجيل الدخول لكل المستخدمين (مدير منصة / مشرف / موظفون)
app.post("/api/auth/login", async (req, res) => {
  const out = await login(req.body?.username, req.body?.password);
  if (!out) return res.status(401).json({ error: "بيانات الدخول غير صحيحة أو الحساب موقوف" });
  res.json(out);
});

// معلومات المستخدم الحالي وصلاحياته
app.get("/api/me", requireAuth, (req, res) =>
  res.json({ id: req.user.id, role: req.user.role, roleLabel: ROLE_LABELS[req.user.role], officeId: req.user.office, permissions: req.user.permissions }));

// بوابة العميل العامة
app.use("/api/public", publicR);

// مدير المنصة: إدارة المكاتب
app.use("/api/admin", requireAuth, requireSuperAdmin, adminR);

// صفحة الاشتراك والدفع (متاحة دائماً للمكتب حتى عند انتهاء الاشتراك)
app.use("/api/subscription", requireAuth, requireOffice, subscriptionR);

// إدارة مستخدمي المكتب الداخليين (المشرف) — تُقفل عند انتهاء الاشتراك
app.use("/api/users", requireAuth, requireOffice, requireActiveSubscription, requirePermission("users.manage"), usersR);

// بيانات المكتب (الطلبات / المستندات / اللوحة / العمالة) — معزولة لكل مكتب وتُقفل عند انتهاء الاشتراك
app.use("/api/orders", requireAuth, requireOffice, requireActiveSubscription, ordersR);
app.use("/api/orders", requireAuth, requireOffice, requireActiveSubscription, documentsR);
app.use("/api/dashboard", requireAuth, requireOffice, requireActiveSubscription, dashboardR);
app.use("/api/workers", requireAuth, requireOffice, requireActiveSubscription, workersR);

const PORT = process.env.PORT || 4000;
await initDb();
app.listen(PORT, () => {
  console.log(`✓ RMS API يعمل على المنفذ ${PORT}`);
  console.log(`  • لوحة مدير المنصة: http://localhost:${PORT}/admin.html`);
  console.log(`  • إدارة مستخدمي المكتب: http://localhost:${PORT}/users.html`);
  console.log(`  • إدارة العمالة المتوفرة: http://localhost:${PORT}/workers.html`);
  console.log(`  • إشعارات حجز السير: http://localhost:${PORT}/notifications.html`);
  console.log(`  • بوابة المتابعة: http://localhost:${PORT}/track.html`);
  console.log(`  • كتالوج العميل: http://localhost:${PORT}/catalog.html?key=...`);
});
