import { Router } from "express";
import { repo } from "../db.js";
import { OFFICE_ROLES, ROLE_LABELS, permsFor } from "../security.js";

const r = Router();

// أنواع الأدوار المتاحة داخل المكتب وصلاحيات كل دور (للعرض في الواجهة)
r.get("/roles", (req, res) =>
  res.json(OFFICE_ROLES.map((role) => ({ role, label: ROLE_LABELS[role], permissions: permsFor(role) }))));

// مستخدمو المكتب الحالي فقط (عزل البيانات)
r.get("/", async (req, res) => res.json(await repo.listUsers(req.user.office)));

// إنشاء مستخدم داخلي بدور محدد
r.post("/", async (req, res) => {
  const { name, username, password, role } = req.body || {};
  if (!username || !password || !role)
    return res.status(400).json({ error: "اسم المستخدم وكلمة المرور والدور مطلوبة." });
  if (!OFFICE_ROLES.includes(role))
    return res.status(400).json({ error: "دور غير صالح." });
  if (await repo.usernameTaken(username))
    return res.status(409).json({ error: "اسم المستخدم مستخدم مسبقاً." });

  const user = await repo.createUser({ officeId: req.user.office, username, name, role, password });
  res.status(201).json(user);
});

// تعديل دور المستخدم أو تفعيله/إيقافه (ضمن نفس المكتب)
r.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "لا يمكنك تعديل حسابك من هنا." });
  const { active, role } = req.body || {};
  if (role && !OFFICE_ROLES.includes(role)) return res.status(400).json({ error: "دور غير صالح." });
  const user = await repo.updateUser(id, req.user.office, { active, role });
  if (!user) return res.status(404).json({ error: "المستخدم غير موجود في مكتبك." });
  res.json(user);
});

export default r;
