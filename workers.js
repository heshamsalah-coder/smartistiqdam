import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { repo } from "../db.js";
import { requirePermission } from "../auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS = process.env.UPLOADS_DIR || path.join(__dirname, "..", "..", "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || (file.fieldname === "photo" ? ".jpg" : "");
    cb(null, `w_${file.fieldname}_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }).fields([
  { name: "photo", maxCount: 1 }, { name: "cv", maxCount: 1 },
]);

const r = Router();
const STATUSES = ["available", "reserved", "hired"];

// قائمة العمالة (داخلي — يشمل الجوال ورقم الجواز)
r.get("/", requirePermission("workers.view"), async (req, res) => {
  res.json(await repo.listWorkers(req.user.office, { status: req.query.status, q: req.query.q }));
});

// رابط بوابة الكتالوج الخاص بالمكتب (لإرساله للعملاء)
r.get("/catalog-link", requirePermission("workers.view"), async (req, res) => {
  const off = await repo.getOffice(req.user.office);
  res.json({ key: off.catalogKey, path: `/catalog.html?key=${off.catalogKey}` });
});

// طلبات الحجز الواردة من العملاء عبر الكتالوج
r.get("/reservations", requirePermission("workers.view"), async (req, res) => {
  res.json(await repo.listReservations(req.user.office));
});

// تحديث حالة طلب حجز (إشعارات المكتب)
r.patch("/reservations/:id", requirePermission("workers.manage"), async (req, res) => {
  const allowed = ["pending", "contacted", "confirmed", "cancelled"];
  if (!allowed.includes(req.body?.status)) return res.status(400).json({ error: "حالة غير صالحة" });
  const out = await repo.updateReservation(Number(req.params.id), req.user.office, req.body.status);
  if (!out) return res.status(404).json({ error: "طلب الحجز غير موجود" });
  res.json(out);
});

// إضافة عاملة (مع صورة وسيرة ذاتية اختيارية)
r.post("/", requirePermission("workers.manage"), upload, async (req, res) => {
  const b = req.body;
  const photoPath = req.files?.photo?.[0]?.path || null;
  const cvPath = req.files?.cv?.[0]?.path || null;
  const w = await repo.createWorker(req.user.office, {
    name: b.name, age: b.age, nationality: b.nationality, profession: b.profession,
    phone: b.phone, passportNo: b.passportNo, status: b.status, photoPath, cvPath,
  });
  res.status(201).json(w);
});

// تعديل بيانات/حالة عاملة أو استبدال الملفات
r.patch("/:id", requirePermission("workers.manage"), upload, async (req, res) => {
  const b = req.body;
  if (b.status && !STATUSES.includes(b.status)) return res.status(400).json({ error: "حالة غير صالحة" });
  const photoPath = req.files?.photo?.[0]?.path;
  const cvPath = req.files?.cv?.[0]?.path;
  const w = await repo.updateWorker(Number(req.params.id), req.user.office, {
    name: b.name, age: b.age, nationality: b.nationality, profession: b.profession,
    phone: b.phone, passportNo: b.passportNo, status: b.status,
    photoPath, cvPath,
  });
  if (!w) return res.status(404).json({ error: "العاملة غير موجودة في مكتبك" });
  res.json(w);
});

// تنزيل الصورة / السيرة داخلياً
r.get("/:id/:kind(photo|cv)", requirePermission("workers.view"), async (req, res) => {
  const w = await repo.getWorkerRaw(Number(req.params.id));
  if (!w || w.office_id !== req.user.office) return res.status(404).json({ error: "غير موجود" });
  const p = req.params.kind === "cv" ? w.cv_path : w.photo_path;
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: "لا يوجد ملف" });
  res.sendFile(path.resolve(p));
});

export default r;
