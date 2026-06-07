import { Router } from "express";
import { repo } from "../db.js";
import { calcFinance, isOverdue, warrantyInfo, STATUSES, STATUS_LABELS } from "../workflow.js";
import { requirePermission } from "../auth.js";

const r = Router();

r.get("/summary", requirePermission("dashboard.view"), async (req, res) => {
  const orders = await repo.listOrders(req.user.office);
  const active = orders.filter((o) => o.status !== "handover");
  const overdue = orders.filter(isOverdue);
  const collected = orders.reduce((s, o) => s + (Number(o.finance.downPayment) || 0), 0);
  const remaining = orders.reduce((s, o) => s + calcFinance(o.finance).remaining, 0);

  const byStatus = STATUSES.map((k) => ({
    key: k, label: STATUS_LABELS[k], count: orders.filter((o) => o.status === k).length,
  }));

  const warrantyExpiring = orders
    .map((o) => ({ orderNo: o.orderNo, client: o.client.name, ...(warrantyInfo(o) || {}) }))
    .filter((x) => x.left >= 0 && x.left <= 30)
    .sort((a, b) => a.left - b.left);

  res.json({
    totalOrders: orders.length,
    activeOrders: active.length,
    overdueOrders: overdue.length,
    collected, remaining,
    byStatus, warrantyExpiring,
  });
});

export default r;
