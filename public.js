import { Router } from "express";
import path from "path";
import fs from "fs";
import { repo } from "../db.js";
import { STATUS_LABELS, warrantyInfo } from "../workflow.js";

const r = Router();

// كتالوج العمالة المتوفرة (عام برابط المكتب) — بيانات مختصرة فقط
r.get("/catalog", async (req, res) => {
  const data = await repo.catalogForOffice(req.query.key);
  if (!data) return res.status(404).json({ error: "رابط غير صالح أو المكتب غير متاح." });
  res.json(data);
});

// صورة/سيرة عاملة من الكتالوج (عام، يتحقق من المفتاح والحالة)
r.get("/catalog/:kind(photo|cv)", async (req, res) => {
  const p = await repo.catalogWorkerFile(req.query.key, Number(req.query.id), req.params.kind);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: "غير متاح" });
  res.sendFile(path.resolve(p));
});

// حجز عاملة من البوابة العامة — يطلب رقم جوال العميل
r.post("/catalog/reserve", async (req, res) => {
  const { key, workerId, phone } = req.body || {};
  const digits = String(phone || "").replace(/[\s-]/g, "");
  if (!key || !workerId) return res.status(400).json({ error: "بيانات الحجز ناقصة." });
  if (!/^\+?\d{9,15}$/.test(digits)) return res.status(400).json({ error: "أدخل رقم جوال صحيح." });
  const out = await repo.reserveFromCatalog(key, Number(workerId), digits);
  if (out.error) return res.status(out.code || 400).json({ error: out.error });
  res.status(201).json({ message: `تم استلام طلب حجز «${out.workerName || "العاملة"}». سيتواصل معك ${out.officeName} قريباً.` });
});

// متابعة عامة — تتحقق من آخر 4 أرقام من الجوال ولا تُرجع بيانات حساسة
r.post("/track", async (req, res) => {
  const { orderNo, phoneLast4 } = req.body || {};
  if (!orderNo || !phoneLast4)
    return res.status(400).json({ error: "أدخل رقم الطلب وآخر 4 أرقام من الجوال." });

  const o = await repo.getOrderByNo(String(orderNo).trim());
  if (!o || !String(o.client.phone || "").endsWith(String(phoneLast4)))
    return res.status(404).json({ error: "لا يوجد طلب مطابق. تحقق من البيانات." });

  res.json({
    orderNo: o.orderNo,
    status: o.status,
    statusLabel: STATUS_LABELS[o.status],
    profession: o.visa.profession,
    nationality: o.visa.nationality,
    arrivalDate: o.worker.arrivalDate || null,
    warranty: warrantyInfo(o),
    timeline: o.history.map((h) => ({ status: h.status, label: STATUS_LABELS[h.status], at: h.at })),
    updates: o.notifications.map((n) => ({ message: n.message, at: n.at })),
  });
});

// بيانات الشركة العامة (تظهر على صفحة الهبوط)
r.get("/company", async (req, res) => res.json(await repo.companyPublic()));

// المقالات المنشورة (لصفحة الهبوط)
r.get("/articles", async (req, res) => res.json(await repo.listArticles(true)));
r.get("/articles/:id", async (req, res) => {
  const a = await repo.getArticle(Number(req.params.id));
  if (!a || a.status !== "published") return res.status(404).json({ error: "المقال غير موجود" });
  res.json(a);
});

export default r;
