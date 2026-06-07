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

const ALLOWED = ["contract", "visa", "invoice", "passport", "medical"];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS),
  filename: (req, file, cb) => {
    const safe = Buffer.from(file.originalname, "latin1").toString("utf8").replace(/[^\w.\u0600-\u06FF-]/g, "_");
    cb(null, `${req.params.id}_${Date.now()}_${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const r = Router();

// رفع مستند (نوع واحد في كل مرة)
r.post("/:id/documents", requirePermission("documents.manage"), upload.single("file"), async (req, res) => {
  const id = Number(req.params.id);
  const type = req.body.type;
  if (!(await repo.getOrder(id, req.user.office))) return res.status(404).json({ error: "الطلب غير موجود" });
  if (!ALLOWED.includes(type)) return res.status(400).json({ error: "نوع المستند غير معروف" });
  if (!req.file) return res.status(400).json({ error: "لم يُرفق ملف" });
  const original = Buffer.from(req.file.originalname, "latin1").toString("utf8");
  const order = await repo.addDocument(id, req.user.office, type, original, req.file.path);
  res.status(201).json(order);
});

// تنزيل مستند
r.get("/:id/documents/:docId", requirePermission("orders.view"), async (req, res) => {
  const doc = await repo.getDocument(Number(req.params.id), req.user.office, Number(req.params.docId));
  if (!doc || !fs.existsSync(doc.file_path)) return res.status(404).json({ error: "المستند غير موجود" });
  res.download(doc.file_path, doc.file_name);
});

export default r;
