import jwt from "jsonwebtoken";
import { repo } from "./db.js";
import { verifyPassword, permsFor, ROLE_LABELS } from "./security.js";

const SECRET = process.env.JWT_SECRET || "dev-secret";

export async function login(username, password) {
  const u = await repo.getUserByUsername(username);
  if (!u || !u.active) return null;
  if (!verifyPassword(password, u.pass_salt, u.pass_hash)) return null;
  if (u.office_id) {
    const off = (await repo.listOffices()).find((o) => o.id === u.office_id);
    if (off && !off.active) return null; // مكتب موقوف
  }
  const token = jwt.sign({ sub: u.id, office: u.office_id, role: u.role }, SECRET, { expiresIn: "12h" });
  return {
    token,
    user: {
      id: u.id, username: u.username, name: u.name, role: u.role,
      roleLabel: ROLE_LABELS[u.role], officeId: u.office_id, permissions: permsFor(u.role),
    },
  };
}

export function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "مطلوب تسجيل الدخول" });
  try {
    const p = jwt.verify(token, SECRET);
    req.user = { id: p.sub, office: p.office, role: p.role, permissions: permsFor(p.role) };
    next();
  } catch {
    return res.status(401).json({ error: "جلسة غير صالحة أو منتهية" });
  }
}

export function requirePermission(perm) {
  return (req, res, next) =>
    req.user?.permissions.includes(perm) ? next() : res.status(403).json({ error: "لا تملك صلاحية لهذا الإجراء" });
}

export function requireSuperAdmin(req, res, next) {
  return req.user?.role === "super_admin" ? next() : res.status(403).json({ error: "مخصص لمدير المنصة فقط" });
}

// يتأكد أن الحساب مرتبط بمكتب (لمسارات بيانات المكتب)
export function requireOffice(req, res, next) {
  if (!req.user?.office) return res.status(403).json({ error: "هذا الحساب غير مرتبط بمكتب" });
  next();
}

// يقفل أدوات المكتب عند انتهاء الاشتراك أو الفترة التجريبية
export async function requireActiveSubscription(req, res, next) {
  if (!req.user?.office) return res.status(403).json({ error: "هذا الحساب غير مرتبط بمكتب" });
  if (await repo.isSubscriptionActive(req.user.office)) return next();
  return res.status(402).json({
    error: "انتهى الاشتراك أو الفترة التجريبية. يرجى تجديد الاشتراك لإعادة تفعيل الأدوات.",
    code: "subscription_required",
  });
}
