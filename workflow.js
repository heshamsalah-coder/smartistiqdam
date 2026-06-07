// قواعد دورة العمل والحسابات — مشتركة بين كل المسارات
export const STATUSES = ["lead", "contract", "visa", "selection", "external", "arrival", "handover"];
export const STATUS_LABELS = {
  lead: "استفسار",
  contract: "تعاقد",
  visa: "تأشيرة",
  selection: "اختيار العامل",
  external: "إجراءات خارجية",
  arrival: "الوصول",
  handover: "التسليم",
};

export const VAT_RATE = 0.15;
export const WARRANTY_DAYS = 90;
export const OVERDUE_DAYS = 14;

export const sIndex = (k) => STATUSES.indexOf(k);
export const nextStatus = (k) => STATUSES[sIndex(k) + 1] || null;

export const today = () => new Date().toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / 86400000);

export function calcFinance(f = {}) {
  const amount = Number(f.contractAmount) || 0;
  const vat = Math.round(amount * VAT_RATE);
  const total = amount + vat;
  const remaining = total - (Number(f.downPayment) || 0);
  return { amount, vat, total, remaining };
}

// يرجّع رسالة خطأ إن لم تتحقق شروط الانتقال، أو null إذا مسموح
export function advanceGuard(order) {
  const next = nextStatus(order.status);
  if (!next) return "الطلب في مرحلته النهائية بالفعل.";
  const hasDoc = (t) => order.documents.some((d) => d.type === t);
  if (next === "contract" && !hasDoc("contract"))
    return "يجب إرفاق عقد العمل قبل الانتقال لمرحلة التعاقد.";
  if (next === "visa" && (!hasDoc("visa") || !order.visa.number))
    return "يجب إرفاق التأشيرة وإدخال رقمها أولاً.";
  if (next === "handover" && !hasDoc("invoice"))
    return "يجب إرفاق فاتورة السداد قبل التسليم.";
  return null;
}

export function notifyMessage(status, order) {
  const map = {
    contract: "تم توثيق عقد العمل بنجاح.",
    visa: `تم إصدار التأشيرة الخاصة بطلبك برقم ${order.visa.number || ""}.`,
    selection: "تم اختيار العامل وجارٍ استكمال الإجراءات.",
    external: "طلبك في مرحلة الإجراءات الخارجية (الفحص الطبي / التفييز / حجز السفر).",
    arrival: `وصل العامل إلى المملكة بتاريخ ${order.worker.arrivalDate}. بدأ احتساب فترة الضمان.`,
    handover: "تم تسليم العامل وإغلاق الطلب وإصدار الفاتورة النهائية. شكراً لثقتك.",
  };
  const base = map[status] || `تم تحديث حالة طلبك إلى: ${STATUS_LABELS[status]}.`;
  return `مكتب الاستقدام | طلب رقم ${order.orderNo}: ${base}`;
}

export function isOverdue(order) {
  if (order.status === "handover") return false;
  const last = order.history?.[order.history.length - 1]?.at || order.createdAt;
  return daysBetween(last, today()) > OVERDUE_DAYS;
}

export function warrantyInfo(order) {
  if (!order.worker?.arrivalDate) return null;
  const end = new Date(order.worker.arrivalDate);
  end.setDate(end.getDate() + (order.warrantyDays || WARRANTY_DAYS));
  const endStr = end.toISOString().slice(0, 10);
  return { end: endStr, left: daysBetween(today(), endStr) };
}
