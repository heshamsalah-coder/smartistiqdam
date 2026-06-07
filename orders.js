import { Router } from "express";
import { repo } from "../db.js";
import { advanceGuard, nextStatus, notifyMessage, today, calcFinance } from "../workflow.js";
import { sendNotification } from "../notifications.js";
import { requirePermission } from "../auth.js";

const r = Router();
const withFinance = (o) => ({ ...o, finance: { ...o.finance, ...calcFinance(o.finance) } });

// قائمة الطلبات — مقيّدة بمكتب المستخدم
r.get("/", requirePermission("orders.view"), async (req, res) => {
  res.json((await repo.listOrders(req.user.office, { status: req.query.status, q: req.query.q })).map(withFinance));
});

r.post("/", requirePermission("orders.create"), async (req, res) => {
  const b = req.body;
  if (!b.client?.name || !b.client?.phone)
    return res.status(400).json({ error: "اسم العميل ورقم الجوال مطلوبان." });
  res.status(201).json(await repo.createOrder(req.user.office, b));
});

r.get("/:id", requirePermission("orders.view"), async (req, res) => {
  const o = await repo.getOrder(Number(req.params.id), req.user.office);
  if (!o) return res.status(404).json({ error: "الطلب غير موجود" });
  res.json(withFinance(o));
});

// تحديث — يُسمح به لمن لديه orders.edit أو finance.edit، مع تصفية الحقول حسب الصلاحية
r.patch("/:id", async (req, res) => {
  const perms = req.user.permissions;
  const canEdit = perms.includes("orders.edit");
  const canFinance = perms.includes("finance.edit");
  if (!canEdit && !canFinance) return res.status(403).json({ error: "لا تملك صلاحية التعديل" });

  const body = { ...req.body };
  if (!canEdit) { delete body.client; delete body.visa; delete body.worker; delete body.warrantyDays; }
  if (!canFinance) delete body.finance;

  const o = await repo.updateOrder(Number(req.params.id), req.user.office, body);
  if (!o) return res.status(404).json({ error: "الطلب غير موجود" });
  res.json(withFinance(o));
});

// نقل المرحلة + إشعار العميل
r.post("/:id/advance", requirePermission("orders.advance"), async (req, res) => {
  const id = Number(req.params.id);
  const order = await repo.getOrder(id, req.user.office);
  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });

  const err = advanceGuard(order);
  if (err) return res.status(422).json({ error: err });

  const next = nextStatus(order.status);
  const arrival = next === "arrival" && !order.worker.arrivalDate ? today() : null;
  const updated = await repo.setStatus(id, req.user.office, next, arrival);

  const message = notifyMessage(next, updated);
  const result = await sendNotification(updated.client.phone, message);
  await repo.addNotification(id, message, result.channel || result.provider, result.status);

  res.json({ order: await repo.getOrder(id, req.user.office), notification: { message, ...result } });
});

export default r;
