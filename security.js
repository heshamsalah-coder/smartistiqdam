import crypto from "crypto";

/* ---------- تشفير كلمات المرور (scrypt مدمج، بدون اعتماديات أصلية) ---------- */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return { salt, hash };
}
export function verifyPassword(pw, salt, hash) {
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  const a = Buffer.from(h, "hex"), b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- الأدوار ---------- */
export const ROLES = ["super_admin", "supervisor", "accountant", "follow_up", "reception"];
export const ROLE_LABELS = {
  super_admin: "مدير المنصة",
  supervisor: "مشرف المكتب",
  accountant: "محاسب",
  follow_up: "موظف متابعة",
  reception: "موظف استقبال",
};
// الأدوار التي يمكن لمشرف المكتب إنشاؤها داخل مكتبه
export const OFFICE_ROLES = ["supervisor", "accountant", "follow_up", "reception"];

/* ---------- الصلاحيات ---------- */
export const PERMISSIONS = [
  "orders.view", "orders.create", "orders.edit", "orders.advance",
  "documents.manage", "finance.view", "finance.edit",
  "workers.view", "workers.manage",
  "dashboard.view", "users.manage", "offices.manage",
];

const ROLE_PERMISSIONS = {
  super_admin: ["offices.manage", "users.manage"],
  supervisor: [
    "orders.view", "orders.create", "orders.edit", "orders.advance",
    "documents.manage", "finance.view", "finance.edit",
    "workers.view", "workers.manage", "dashboard.view", "users.manage",
  ],
  accountant: ["orders.view", "finance.view", "finance.edit", "documents.manage", "workers.view", "dashboard.view"],
  follow_up: ["orders.view", "orders.edit", "orders.advance", "documents.manage", "workers.view", "workers.manage", "dashboard.view"],
  reception: ["orders.view", "orders.create", "orders.edit", "documents.manage", "workers.view", "workers.manage"],
};

export const permsFor = (role) => ROLE_PERMISSIONS[role] || [];
