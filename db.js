import crypto from "crypto";
import mysql from "mysql2/promise";
import { today } from "./workflow.js";
import { hashPassword } from "./security.js";

/* ===== اتصال MySQL ===== */
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "siq",
  password: process.env.DB_PASSWORD || "siqpass",
  database: process.env.DB_NAME || "smartistiqdam",
  waitForConnections: true,
  connectionLimit: 10,
  charset: "utf8mb4",
  decimalNumbers: true,
});

const all = async (sql, p = []) => { const [rows] = await pool.query(sql, p); return rows; };
const get = async (sql, p = []) => { const [rows] = await pool.query(sql, p); return rows[0]; };
const run = async (sql, p = []) => { const [r] = await pool.query(sql, p); return { lastInsertRowid: r.insertId, changes: r.affectedRows }; };
async function tx(fn) {
  const conn = await pool.getConnection();
  try { await conn.beginTransaction(); const r = await fn(conn); await conn.commit(); return r; }
  catch (e) { await conn.rollback(); throw e; }
  finally { conn.release(); }
}

/* ===== أدوات ===== */
export const TRIAL_DAYS = Number(process.env.SUB_TRIAL_DAYS || 14);
const isoDate = (d = new Date()) => d.toISOString().slice(0, 10);
const addDays = (n, from = new Date()) => { const d = new Date(from); d.setDate(d.getDate() + n); return isoDate(d); };
function computeStatus(sub) {
  if (!sub) return { status: "none", active: false, daysLeft: 0 };
  if (sub.plan_code === "lifetime" || !sub.end_at) return { status: "active", active: true, daysLeft: null };
  const t = isoDate();
  const daysLeft = Math.max(0, Math.round((new Date(sub.end_at) - new Date(t)) / 86400000));
  if (sub.end_at < t) return { status: sub.is_trial ? "trial_expired" : "expired", active: false, daysLeft: 0 };
  return { status: sub.is_trial ? "trialing" : "active", active: true, daysLeft };
}

/* ===== المابرز (غير متزامنة لأنها تستعلم) ===== */
async function rowToOrder(o) {
  const client = (await get("SELECT * FROM clients WHERE id=?", [o.client_id])) || {};
  const documents = (await all("SELECT id,type,file_name,added_at FROM documents WHERE order_id=?", [o.id]))
    .map((d) => ({ id: d.id, type: d.type, name: d.file_name, addedAt: d.added_at }));
  const notifications = (await all("SELECT message,channel,status,sent_at FROM notifications WHERE order_id=? ORDER BY id", [o.id]))
    .map((n) => ({ message: n.message, channel: n.channel, status: n.status, at: n.sent_at }));
  const history = (await all("SELECT status,changed_at FROM order_history WHERE order_id=? ORDER BY id", [o.id]))
    .map((h) => ({ status: h.status, at: h.changed_at }));
  return {
    id: o.id, officeId: o.office_id, orderNo: o.order_no, status: o.status,
    createdAt: o.created_at, warrantyDays: o.warranty_days,
    client: { name: client.name, idNumber: client.id_number, phone: client.phone, city: client.city },
    visa: { number: o.visa_number, issueDate: o.visa_issue_date, profession: o.profession, nationality: o.nationality },
    worker: { name: o.worker_name, passportNo: o.passport_no, birthDate: o.birth_date, healthStatus: o.health_status, arrivalDate: o.arrival_date, flightNo: o.flight_no },
    finance: { contractAmount: o.contract_amount, downPayment: o.down_payment, govFees: o.gov_fees },
    documents, notifications, history,
  };
}
const pubUser = (u) => u && ({ id: u.id, officeId: u.office_id, username: u.username, name: u.name, role: u.role, active: !!u.active, createdAt: u.created_at });
async function fullWorker(w) {
  if (!w) return null;
  const r = await get("SELECT client_phone, status, created_at FROM reservations WHERE worker_id=? ORDER BY id DESC LIMIT 1", [w.id]);
  return {
    id: w.id, officeId: w.office_id, name: w.name, age: w.age, nationality: w.nationality,
    profession: w.profession, phone: w.phone, passportNo: w.passport_no, status: w.status,
    hasPhoto: !!w.photo_path, hasCv: !!w.cv_path, createdAt: w.created_at,
    reservation: r ? { clientPhone: r.client_phone, status: r.status, at: r.created_at } : null,
  };
}
const catalogWorker = (w, key) => ({
  id: w.id, name: w.name, age: w.age, nationality: w.nationality, profession: w.profession,
  photoUrl: w.photo_path ? `/api/public/catalog/photo?key=${key}&id=${w.id}` : null,
  cvUrl: w.cv_path ? `/api/public/catalog/cv?key=${key}&id=${w.id}` : null,
});

/* ===== المستودع (كل الدوال async) ===== */
export const repo = {
  /* offices */
  async listOffices() {
    const offices = await all("SELECT * FROM offices ORDER BY id");
    return Promise.all(offices.map(async (o) => ({
      id: o.id, name: o.name, active: !!o.active, catalogKey: o.catalog_key, createdAt: o.created_at,
      users: Number((await get("SELECT COUNT(*) n FROM users WHERE office_id=?", [o.id])).n),
      orders: Number((await get("SELECT COUNT(*) n FROM orders WHERE office_id=?", [o.id])).n),
      workers: Number((await get("SELECT COUNT(*) n FROM workers WHERE office_id=?", [o.id])).n),
      subscription: await this.getSubscription(o.id),
    })));
  },
  async createOffice(name) {
    const key = crypto.randomBytes(8).toString("hex");
    const info = await run("INSERT INTO offices(name,active,catalog_key,created_at) VALUES(?,1,?,?)", [name, key, today()]);
    const id = Number(info.lastInsertRowid);
    await this.startTrial(id);
    return id;
  },
  async getOffice(id) {
    const o = await get("SELECT * FROM offices WHERE id=?", [id]);
    return o && { id: o.id, name: o.name, active: !!o.active, catalogKey: o.catalog_key };
  },
  async getOfficeByCatalogKey(key) {
    const o = await get("SELECT * FROM offices WHERE catalog_key=?", [key]);
    return o && { id: o.id, name: o.name, active: !!o.active, catalogKey: o.catalog_key };
  },
  async setOfficeActive(id, active) {
    await run("UPDATE offices SET active=? WHERE id=?", [active ? 1 : 0, id]);
    return get("SELECT * FROM offices WHERE id=?", [id]);
  },

  /* users */
  async getUserByUsername(username) { return get("SELECT * FROM users WHERE username=?", [username]); },
  async usernameTaken(username) { return !!(await get("SELECT 1 t FROM users WHERE username=?", [username])); },
  async listUsers(officeId) { return (await all("SELECT * FROM users WHERE office_id=? ORDER BY id", [officeId])).map(pubUser); },
  async createUser({ officeId, username, name, role, password }) {
    const { salt, hash } = hashPassword(password);
    const info = await run("INSERT INTO users(office_id,username,name,role,pass_salt,pass_hash,active,created_at) VALUES(?,?,?,?,?,?,1,?)",
      [officeId ?? null, username, name || null, role, salt, hash, today()]);
    return pubUser(await get("SELECT * FROM users WHERE id=?", [Number(info.lastInsertRowid)]));
  },
  async updateUser(id, officeId, { active, role }) {
    const u = await get("SELECT * FROM users WHERE id=? AND office_id=?", [id, officeId]);
    if (!u) return null;
    if (active !== undefined) await run("UPDATE users SET active=? WHERE id=?", [active ? 1 : 0, id]);
    if (role) await run("UPDATE users SET role=? WHERE id=?", [role, id]);
    return pubUser(await get("SELECT * FROM users WHERE id=?", [id]));
  },

  /* orders */
  async listOrders(officeId, { status, q } = {}) {
    const rows = await all("SELECT * FROM orders WHERE office_id=? ORDER BY id DESC", [officeId]);
    let result = await Promise.all(rows.map(rowToOrder));
    if (status) result = result.filter((o) => o.status === status);
    if (q) { const t = q.toLowerCase(); result = result.filter((o) => [o.orderNo, o.client.name, o.client.phone, o.visa.number].join(" ").toLowerCase().includes(t)); }
    return result;
  },
  async getOrder(id, officeId) {
    const o = await get("SELECT * FROM orders WHERE id=? AND office_id=?", [id, officeId]);
    return o ? rowToOrder(o) : null;
  },
  async getOrderByNo(orderNo) {
    const o = await get("SELECT * FROM orders WHERE order_no=?", [orderNo]);
    return o ? rowToOrder(o) : null;
  },
  async nextOrderNo() {
    return "REC-" + (1067 + Number((await get("SELECT COUNT(*) n FROM orders")).n));
  },
  async createOrder(officeId, data) {
    const orderNo = data.orderNo || (await this.nextOrderNo());
    const orderId = await tx(async (conn) => {
      const [cl] = await conn.query("INSERT INTO clients(office_id,name,id_number,phone,city) VALUES(?,?,?,?,?)",
        [officeId, data.client.name, data.client.idNumber || null, data.client.phone, data.client.city || null]);
      const [info] = await conn.query(`INSERT INTO orders
        (office_id,order_no,client_id,status,warranty_days,created_at,profession,nationality,contract_amount)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [officeId, orderNo, cl.insertId, "lead", data.warrantyDays || 90, today(),
          data.visa?.profession || null, data.visa?.nationality || null, data.finance?.contractAmount || 0]);
      await conn.query("INSERT INTO order_history(order_id,status,changed_at) VALUES(?,?,?)", [info.insertId, "lead", today()]);
      return info.insertId;
    });
    return this.getOrder(orderId, officeId);
  },
  async updateOrder(id, officeId, p) {
    const o = await get("SELECT * FROM orders WHERE id=? AND office_id=?", [id, officeId]);
    if (!o) return null;
    if (p.client) await run("UPDATE clients SET name=COALESCE(?,name),id_number=COALESCE(?,id_number),phone=COALESCE(?,phone),city=COALESCE(?,city) WHERE id=?",
      [p.client.name ?? null, p.client.idNumber ?? null, p.client.phone ?? null, p.client.city ?? null, o.client_id]);
    const v = p.visa || {}, w = p.worker || {}, f = p.finance || {};
    await run(`UPDATE orders SET
      visa_number=COALESCE(?,visa_number), visa_issue_date=COALESCE(?,visa_issue_date),
      profession=COALESCE(?,profession), nationality=COALESCE(?,nationality),
      worker_name=COALESCE(?,worker_name), passport_no=COALESCE(?,passport_no),
      birth_date=COALESCE(?,birth_date), health_status=COALESCE(?,health_status),
      arrival_date=COALESCE(?,arrival_date), flight_no=COALESCE(?,flight_no),
      contract_amount=COALESCE(?,contract_amount), down_payment=COALESCE(?,down_payment),
      gov_fees=COALESCE(?,gov_fees), warranty_days=COALESCE(?,warranty_days) WHERE id=?`,
      [v.number ?? null, v.issueDate ?? null, v.profession ?? null, v.nationality ?? null,
        w.name ?? null, w.passportNo ?? null, w.birthDate ?? null, w.healthStatus ?? null,
        w.arrivalDate ?? null, w.flightNo ?? null,
        f.contractAmount ?? null, f.downPayment ?? null, f.govFees ?? null, p.warrantyDays ?? null, id]);
    return this.getOrder(id, officeId);
  },
  async setStatus(id, officeId, status, arrivalDate) {
    await run("UPDATE orders SET status=? WHERE id=? AND office_id=?", [status, id, officeId]);
    if (status === "arrival" && arrivalDate)
      await run("UPDATE orders SET arrival_date=COALESCE(arrival_date,?) WHERE id=?", [arrivalDate, id]);
    await run("INSERT INTO order_history(order_id,status,changed_at) VALUES(?,?,?)", [id, status, today()]);
    return this.getOrder(id, officeId);
  },
  async addDocument(id, officeId, type, fileName, filePath) {
    if (!(await this.getOrder(id, officeId))) return null;
    await run("DELETE FROM documents WHERE order_id=? AND type=?", [id, type]);
    await run("INSERT INTO documents(order_id,type,file_name,file_path,added_at) VALUES(?,?,?,?,?)", [id, type, fileName, filePath, today()]);
    return this.getOrder(id, officeId);
  },
  async getDocument(orderId, officeId, docId) {
    if (!(await this.getOrder(orderId, officeId))) return null;
    return get("SELECT * FROM documents WHERE id=? AND order_id=?", [docId, orderId]);
  },
  async addNotification(id, message, channel, status) {
    await run("INSERT INTO notifications(order_id,message,channel,status,sent_at) VALUES(?,?,?,?,?)", [id, message, channel, status, today()]);
  },

  /* workers */
  async listWorkers(officeId, { status, q } = {}) {
    const rows = await all("SELECT * FROM workers WHERE office_id=? ORDER BY id DESC", [officeId]);
    let result = await Promise.all(rows.map(fullWorker));
    if (status) result = result.filter((w) => w.status === status);
    if (q) { const t = q.toLowerCase(); result = result.filter((w) => [w.name, w.nationality, w.profession, w.passportNo].join(" ").toLowerCase().includes(t)); }
    return result;
  },
  async getWorker(id, officeId) {
    const w = await get("SELECT * FROM workers WHERE id=? AND office_id=?", [id, officeId]);
    return w ? fullWorker(w) : null;
  },
  async getWorkerRaw(id) { return get("SELECT * FROM workers WHERE id=?", [id]); },
  async createWorker(officeId, d) {
    const info = await run(`INSERT INTO workers(office_id,name,age,nationality,profession,phone,passport_no,photo_path,cv_path,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [officeId, d.name || null, d.age ? Number(d.age) : null, d.nationality || null, d.profession || null,
        d.phone || null, d.passportNo || null, d.photoPath || null, d.cvPath || null, d.status || "available", today()]);
    return this.getWorker(Number(info.lastInsertRowid), officeId);
  },
  async updateWorker(id, officeId, d) {
    const w = await get("SELECT * FROM workers WHERE id=? AND office_id=?", [id, officeId]);
    if (!w) return null;
    await run(`UPDATE workers SET name=COALESCE(?,name),age=COALESCE(?,age),nationality=COALESCE(?,nationality),
      profession=COALESCE(?,profession),phone=COALESCE(?,phone),passport_no=COALESCE(?,passport_no),
      photo_path=COALESCE(?,photo_path),cv_path=COALESCE(?,cv_path),status=COALESCE(?,status) WHERE id=?`,
      [d.name ?? null, d.age ?? null, d.nationality ?? null, d.profession ?? null, d.phone ?? null,
        d.passportNo ?? null, d.photoPath ?? null, d.cvPath ?? null, d.status ?? null, id]);
    return this.getWorker(id, officeId);
  },
  async catalogForOffice(key) {
    const off = await this.getOfficeByCatalogKey(key);
    if (!off || !off.active) return null;
    const rows = await all("SELECT * FROM workers WHERE office_id=? AND status='available' ORDER BY id DESC", [off.id]);
    const nationalities = [...new Set(rows.map((r) => r.nationality).filter(Boolean))];
    return { officeName: off.name, nationalities, workers: rows.map((w) => catalogWorker(w, key)) };
  },
  async catalogWorkerFile(key, id, kind) {
    const off = await this.getOfficeByCatalogKey(key);
    if (!off || !off.active) return null;
    const w = await get("SELECT * FROM workers WHERE id=? AND office_id=? AND status='available'", [id, off.id]);
    if (!w) return null;
    return kind === "cv" ? w.cv_path : w.photo_path;
  },
  async reserveFromCatalog(key, workerId, clientPhone) {
    const off = await this.getOfficeByCatalogKey(key);
    if (!off || !off.active) return { error: "رابط غير صالح أو المكتب غير متاح.", code: 404 };
    const w = await get("SELECT * FROM workers WHERE id=? AND office_id=?", [workerId, off.id]);
    if (!w) return { error: "العاملة غير موجودة.", code: 404 };
    if (w.status !== "available") return { error: "تم حجز هذه العاملة بالفعل.", code: 409 };
    try {
      await tx(async (conn) => {
        await conn.query("INSERT INTO reservations(worker_id,office_id,client_phone,status,created_at) VALUES(?,?,?,?,?)", [workerId, off.id, clientPhone, "pending", today()]);
        await conn.query("UPDATE workers SET status='reserved' WHERE id=?", [workerId]);
      });
    } catch (e) { return { error: "تعذّر إتمام الحجز.", code: 500 }; }
    return { ok: true, workerName: w.name, officeName: off.name };
  },
  async listReservations(officeId) {
    return (await all(`SELECT r.id, r.client_phone, r.status, r.created_at, r.worker_id, w.name worker_name, w.nationality, w.profession, w.status worker_status
      FROM reservations r JOIN workers w ON w.id=r.worker_id WHERE r.office_id=? ORDER BY r.id DESC`, [officeId]))
      .map((r) => ({ id: r.id, clientPhone: r.client_phone, status: r.status, at: r.created_at,
        worker: { id: r.worker_id, name: r.worker_name, nationality: r.nationality, profession: r.profession, status: r.worker_status } }));
  },
  async updateReservation(id, officeId, status) {
    const r = await get("SELECT * FROM reservations WHERE id=? AND office_id=?", [id, officeId]);
    if (!r) return null;
    await run("UPDATE reservations SET status=? WHERE id=?", [status, id]);
    if (status === "cancelled") await run("UPDATE workers SET status='available' WHERE id=?", [r.worker_id]);
    if (status === "confirmed") await run("UPDATE workers SET status='reserved' WHERE id=?", [r.worker_id]);
    return { ok: true };
  },

  /* subscriptions & plans */
  async listPlans() {
    return (await all("SELECT * FROM plans WHERE active=1 ORDER BY price")).map((p) => ({
      code: p.code, name: p.name, price: p.price, durationDays: p.duration_days, vat: p.vat,
      vatAmount: Math.round(p.price * p.vat * 100) / 100,
      total: Math.round(p.price * (1 + p.vat) * 100) / 100,
    }));
  },
  async getPlan(code) { return get("SELECT * FROM plans WHERE code=? AND active=1", [code]); },
  async updatePlan(code, { price, name }) {
    const p = await this.getPlan(code); if (!p) return null;
    await run("UPDATE plans SET price=?,name=? WHERE code=?", [price != null ? Number(price) : p.price, name ?? p.name, code]);
    return this.getPlan(code);
  },
  async getSubscription(officeId) {
    const s = await get("SELECT * FROM subscriptions WHERE office_id=?", [officeId]);
    const st = computeStatus(s);
    return { planCode: s ? s.plan_code : null, isTrial: s ? !!s.is_trial : false, startAt: s ? s.start_at : null, endAt: s ? s.end_at : null, ...st };
  },
  async isSubscriptionActive(officeId) { return (await this.getSubscription(officeId)).active; },
  async startTrial(officeId, days) {
    const d = days || Number(await this.getSetting("trial_days")) || TRIAL_DAYS;
    const exists = await get("SELECT office_id FROM subscriptions WHERE office_id=?", [officeId]);
    if (exists) await run("UPDATE subscriptions SET plan_code='trial',is_trial=1,start_at=?,end_at=? WHERE office_id=?", [isoDate(), addDays(d), officeId]);
    else await run("INSERT INTO subscriptions(office_id,plan_code,is_trial,start_at,end_at,created_at) VALUES(?,?,1,?,?,?)", [officeId, "trial", isoDate(), addDays(d), today()]);
    return this.getSubscription(officeId);
  },
  async activatePlan(officeId, planCode) {
    const plan = await this.getPlan(planCode);
    if (!plan) return null;
    let end = null;
    if (plan.duration_days) {
      const cur = await get("SELECT end_at,is_trial FROM subscriptions WHERE office_id=?", [officeId]);
      const base = (cur && cur.end_at && !cur.is_trial && cur.end_at >= isoDate()) ? new Date(cur.end_at) : new Date();
      end = addDays(plan.duration_days, base);
    }
    const exists = await get("SELECT start_at FROM subscriptions WHERE office_id=?", [officeId]);
    if (exists) await run("UPDATE subscriptions SET plan_code=?,is_trial=0,start_at=COALESCE(start_at,?),end_at=? WHERE office_id=?", [planCode, isoDate(), end, officeId]);
    else await run("INSERT INTO subscriptions(office_id,plan_code,is_trial,start_at,end_at,created_at) VALUES(?,?,0,?,?,?)", [officeId, planCode, isoDate(), end, today()]);
    return this.getSubscription(officeId);
  },
  async recordPayment(officeId, planCode, amount, vat, total, status, provider, ref) {
    await run("INSERT INTO payments(office_id,plan_code,amount,vat,total,status,provider,ref,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [officeId, planCode, amount, vat, total, status, provider || null, ref || null, today()]);
  },
  async listPayments(officeId) {
    return all("SELECT id,plan_code,amount,vat,total,status,provider,ref,created_at FROM payments WHERE office_id=? ORDER BY id DESC", [officeId]);
  },

  /* settings (key-value) */
  async getSetting(key) { const r = await get("SELECT sval FROM settings WHERE skey=?", [key]); return r ? r.sval : null; },
  async setSetting(key, value) {
    const e = await get("SELECT skey FROM settings WHERE skey=?", [key]);
    if (e) await run("UPDATE settings SET sval=? WHERE skey=?", [value, key]);
    else await run("INSERT INTO settings(skey,sval) VALUES(?,?)", [key, value]);
  },
  async allSettings() { const o = {}; (await all("SELECT skey,sval FROM settings")).forEach((r) => (o[r.skey] = r.sval)); return o; },
  async companyPublic() {
    const s = await this.allSettings();
    return {
      name: s.company_name || "الاستقدام الذكي", email: s.company_email || "", whatsapp: s.company_whatsapp || "",
      phone: s.company_phone || "", cr: s.company_cr || "", vatNo: s.company_vat || "", address: s.company_address || "",
    };
  },

  /* articles */
  async listArticles(publishedOnly = false) {
    const sql = "SELECT id,slug,title,excerpt,status,created_at,updated_at FROM articles" + (publishedOnly ? " WHERE status='published'" : "") + " ORDER BY id DESC";
    return all(sql);
  },
  async getArticle(id) { return get("SELECT * FROM articles WHERE id=?", [id]); },
  async createArticle({ title, excerpt, body, status }) {
    const slug = String(title || "").trim().replace(/\s+/g, "-").replace(/[^\u0600-\u06FF\w-]/g, "").slice(0, 80) || null;
    const info = await run("INSERT INTO articles(slug,title,excerpt,body,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      [slug, title, excerpt || "", body || "", status === "published" ? "published" : "draft", today(), today()]);
    return this.getArticle(Number(info.lastInsertRowid));
  },
  async updateArticle(id, { title, excerpt, body, status }) {
    const a = await this.getArticle(id); if (!a) return null;
    await run("UPDATE articles SET title=?,excerpt=?,body=?,status=?,updated_at=? WHERE id=?",
      [title ?? a.title, excerpt ?? a.excerpt, body ?? a.body, status ?? a.status, today(), id]);
    return this.getArticle(id);
  },
  async deleteArticle(id) { await run("DELETE FROM articles WHERE id=?", [id]); return { ok: true }; },

  /* invoices */
  async nextInvoiceNumber() {
    const y = new Date().getFullYear();
    const n = Number((await get("SELECT COUNT(*) c FROM invoices")).c) + 1;
    return `INV-${y}-${String(n).padStart(4, "0")}`;
  },
  async createInvoice({ officeId, planCode, description, amount, vat, total, buyerName }) {
    const number = await this.nextInvoiceNumber();
    await run("INSERT INTO invoices(number,office_id,plan_code,description,amount,vat,total,buyer_name,issued_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [number, officeId, planCode || null, description || null, amount, vat, total, buyerName || null, today()]);
    return get("SELECT * FROM invoices WHERE number=?", [number]);
  },
  async listInvoices(officeId) {
    return officeId ? all("SELECT * FROM invoices WHERE office_id=? ORDER BY id DESC", [officeId]) : all("SELECT * FROM invoices ORDER BY id DESC");
  },
  async getInvoice(id) { return get("SELECT * FROM invoices WHERE id=?", [id]); },
};

/* ===== التهيئة (الجداول + البذور) ===== */
export async function initDb() {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS offices (id INT AUTO_INCREMENT PRIMARY KEY, name TEXT NOT NULL, active TINYINT NOT NULL DEFAULT 1, catalog_key VARCHAR(64), created_at VARCHAR(20) NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, office_id INT, username VARCHAR(190) UNIQUE NOT NULL, name VARCHAR(190), role VARCHAR(40) NOT NULL, pass_salt VARCHAR(190) NOT NULL, pass_hash VARCHAR(255) NOT NULL, active TINYINT NOT NULL DEFAULT 1, created_at VARCHAR(20) NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS clients (id INT AUTO_INCREMENT PRIMARY KEY, office_id INT NOT NULL, name VARCHAR(190) NOT NULL, id_number VARCHAR(40), phone VARCHAR(40) NOT NULL, city VARCHAR(80))`,
    `CREATE TABLE IF NOT EXISTS orders (id INT AUTO_INCREMENT PRIMARY KEY, office_id INT NOT NULL, order_no VARCHAR(40) UNIQUE NOT NULL, client_id INT NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'lead', warranty_days INT DEFAULT 90, created_at VARCHAR(20) NOT NULL, visa_number VARCHAR(60), visa_issue_date VARCHAR(20), profession VARCHAR(120), nationality VARCHAR(80), worker_name VARCHAR(190), passport_no VARCHAR(60), birth_date VARCHAR(20), health_status VARCHAR(120), arrival_date VARCHAR(20), flight_no VARCHAR(40), contract_amount DECIMAL(12,2) DEFAULT 0, down_payment DECIMAL(12,2) DEFAULT 0, gov_fees DECIMAL(12,2) DEFAULT 0, INDEX(office_id))`,
    `CREATE TABLE IF NOT EXISTS documents (id INT AUTO_INCREMENT PRIMARY KEY, order_id INT NOT NULL, type VARCHAR(40) NOT NULL, file_name VARCHAR(255) NOT NULL, file_path TEXT NOT NULL, added_at VARCHAR(20) NOT NULL, INDEX(order_id))`,
    `CREATE TABLE IF NOT EXISTS notifications (id INT AUTO_INCREMENT PRIMARY KEY, order_id INT NOT NULL, message TEXT NOT NULL, channel VARCHAR(40), status VARCHAR(40), sent_at VARCHAR(20) NOT NULL, INDEX(order_id))`,
    `CREATE TABLE IF NOT EXISTS order_history (id INT AUTO_INCREMENT PRIMARY KEY, order_id INT NOT NULL, status VARCHAR(30) NOT NULL, changed_at VARCHAR(20) NOT NULL, INDEX(order_id))`,
    `CREATE TABLE IF NOT EXISTS workers (id INT AUTO_INCREMENT PRIMARY KEY, office_id INT NOT NULL, name VARCHAR(190), age INT, nationality VARCHAR(80), profession VARCHAR(120), phone VARCHAR(40), passport_no VARCHAR(60), photo_path TEXT, cv_path TEXT, status VARCHAR(30) NOT NULL DEFAULT 'available', created_at VARCHAR(20) NOT NULL, INDEX(office_id))`,
    `CREATE TABLE IF NOT EXISTS reservations (id INT AUTO_INCREMENT PRIMARY KEY, worker_id INT NOT NULL, office_id INT NOT NULL, client_phone VARCHAR(40) NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'pending', created_at VARCHAR(20) NOT NULL, INDEX(office_id), INDEX(worker_id))`,
    `CREATE TABLE IF NOT EXISTS plans (code VARCHAR(64) PRIMARY KEY, name VARCHAR(120) NOT NULL, price DECIMAL(12,2) NOT NULL, duration_days INT, vat DECIMAL(4,2) NOT NULL DEFAULT 0.15, active TINYINT NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS subscriptions (office_id INT PRIMARY KEY, plan_code VARCHAR(64), is_trial TINYINT NOT NULL DEFAULT 0, start_at VARCHAR(20), end_at VARCHAR(20), created_at VARCHAR(20) NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS payments (id INT AUTO_INCREMENT PRIMARY KEY, office_id INT NOT NULL, plan_code VARCHAR(64) NOT NULL, amount DECIMAL(12,2) NOT NULL, vat DECIMAL(12,2) NOT NULL, total DECIMAL(12,2) NOT NULL, status VARCHAR(30) NOT NULL, provider VARCHAR(40), ref VARCHAR(190), created_at VARCHAR(20) NOT NULL, INDEX(office_id))`,
    `CREATE TABLE IF NOT EXISTS settings (skey VARCHAR(120) PRIMARY KEY, sval TEXT)`,
    `CREATE TABLE IF NOT EXISTS articles (id INT AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(190), title VARCHAR(255) NOT NULL, excerpt TEXT, body LONGTEXT, status VARCHAR(20) NOT NULL DEFAULT 'draft', created_at VARCHAR(20) NOT NULL, updated_at VARCHAR(20))`,
    `CREATE TABLE IF NOT EXISTS invoices (id INT AUTO_INCREMENT PRIMARY KEY, number VARCHAR(64) UNIQUE, office_id INT NOT NULL, plan_code VARCHAR(64), description VARCHAR(255), amount DECIMAL(12,2) NOT NULL, vat DECIMAL(12,2) NOT NULL, total DECIMAL(12,2) NOT NULL, buyer_name VARCHAR(190), issued_at VARCHAR(20) NOT NULL, INDEX(office_id))`,
  ];
  for (const s of ddl) await pool.query(s);

  // خطط الاشتراك
  const ensurePlan = async (code, name, price, days) => {
    if (!(await get("SELECT code FROM plans WHERE code=?", [code])))
      await run("INSERT INTO plans(code,name,price,duration_days,vat,active) VALUES(?,?,?,?,0.15,1)", [code, name, price, days]);
  };
  await ensurePlan("monthly", "اشتراك شهري", 200, 30);
  await ensurePlan("yearly", "اشتراك سنوي", 800, 365);
  await ensurePlan("lifetime", "اشتراك مدى الحياة", 2000, null);

  // مدير المنصة — مرة واحدة
  if (Number((await get("SELECT COUNT(*) n FROM users")).n) === 0) {
    const { salt, hash } = hashPassword(process.env.SUPERADMIN_PASS || "super123");
    await run("INSERT INTO users(office_id,username,name,role,pass_salt,pass_hash,active,created_at) VALUES(?,?,?,?,?,?,1,?)",
      [null, process.env.SUPERADMIN_USER || "super", "مدير المنصة", "super_admin", salt, hash, today()]);
  }

  // بيانات تجريبية — تُعطَّل بـ SEED_DEMO=false
  if (process.env.SEED_DEMO !== "false" && Number((await get("SELECT COUNT(*) n FROM offices")).n) === 0) {
    const mk = async (officeId, username, name, role, pw) => {
      const { salt, hash } = hashPassword(pw);
      await run("INSERT INTO users(office_id,username,name,role,pass_salt,pass_hash,active,created_at) VALUES(?,?,?,?,?,?,1,?)", [officeId, username, name, role, salt, hash, today()]);
    };
    const off1 = await repo.createOffice("مكتب الرياض للاستقدام");
    await mk(off1, "supervisor", "مشرف الرياض", "supervisor", "sup123");
    await mk(off1, "accountant", "محاسب الرياض", "accountant", "acc123");
    await mk(off1, "followup", "موظف متابعة", "follow_up", "fu123");
    await mk(off1, "reception", "موظف استقبال", "reception", "rec123");
    const off2 = await repo.createOffice("مكتب جدة للاستقدام");
    await mk(off2, "jeddah", "مشرف جدة", "supervisor", "jed123");

    const cl1 = await run("INSERT INTO clients(office_id,name,id_number,phone,city) VALUES(?,?,?,?,?)", [off1, "عبدالله الشهري", "1098456321", "0551234567", "الرياض"]);
    const o1 = await run(`INSERT INTO orders (office_id,order_no,client_id,status,created_at,visa_number,visa_issue_date,profession,nationality,contract_amount,down_payment,gov_fees)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [off1, "REC-1042", cl1.lastInsertRowid, "external", "2026-05-02", "4023118765", "2026-05-10", "عاملة منزلية", "الفلبين", 13000, 5000, 2000]);
    await run("INSERT INTO documents(order_id,type,file_name,file_path,added_at) VALUES(?,?,?,?,?)", [o1.lastInsertRowid, "contract", "عقد-REC1042.pdf", "seed", "2026-05-03"]);
    await run("INSERT INTO documents(order_id,type,file_name,file_path,added_at) VALUES(?,?,?,?,?)", [o1.lastInsertRowid, "visa", "تأشيرة-4023.jpg", "seed", "2026-05-11"]);
    for (const s of ["lead:2026-05-02","contract:2026-05-03","visa:2026-05-11","selection:2026-05-18","external:2026-05-22"]) { const [st, dt] = s.split(":"); await run("INSERT INTO order_history(order_id,status,changed_at) VALUES(?,?,?)", [o1.lastInsertRowid, st, dt]); }

    const cl2 = await run("INSERT INTO clients(office_id,name,id_number,phone,city) VALUES(?,?,?,?,?)", [off1, "نورة القحطاني", "1076553410", "0509988776", "جدة"]);
    const o2 = await run(`INSERT INTO orders (office_id,order_no,client_id,status,created_at,visa_number,profession,nationality,worker_name,passport_no,health_status,arrival_date,flight_no,contract_amount,down_payment,gov_fees)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [off1, "REC-1051", cl2.lastInsertRowid, "arrival", "2026-03-15", "4019887210", "سائق خاص", "بنغلاديش", "Rahim Uddin", "BX4410922", "لائق طبياً", "2026-05-20", "SV804", 11000, 11000, 2000]);
    for (const t of ["contract","visa","invoice"]) await run("INSERT INTO documents(order_id,type,file_name,file_path,added_at) VALUES(?,?,?,?,?)", [o2.lastInsertRowid, t, `${t}-1051`, "seed", "2026-03-16"]);
    for (const s of ["lead:2026-03-15","contract:2026-03-16","visa:2026-03-26","selection:2026-04-05","external:2026-04-20","arrival:2026-05-20"]) { const [st, dt] = s.split(":"); await run("INSERT INTO order_history(order_id,status,changed_at) VALUES(?,?,?)", [o2.lastInsertRowid, st, dt]); }

    const cl3 = await run("INSERT INTO clients(office_id,name,id_number,phone,city) VALUES(?,?,?,?,?)", [off2, "خالد الحربي", "1055667788", "0544556677", "جدة"]);
    const o3 = await run(`INSERT INTO orders (office_id,order_no,client_id,status,created_at,profession,nationality,contract_amount) VALUES (?,?,?,?,?,?,?,?)`, [off2, "REC-1052", cl3.lastInsertRowid, "contract", "2026-05-28", "عاملة منزلية", "إثيوبيا", 12500]);
    await run("INSERT INTO documents(order_id,type,file_name,file_path,added_at) VALUES(?,?,?,?,?)", [o3.lastInsertRowid, "contract", "عقد-1052.pdf", "seed", "2026-05-29"]);
    for (const s of ["lead:2026-05-28","contract:2026-05-29"]) { const [st, dt] = s.split(":"); await run("INSERT INTO order_history(order_id,status,changed_at) VALUES(?,?,?)", [o3.lastInsertRowid, st, dt]); }

    const wk = `INSERT INTO workers(office_id,name,age,nationality,profession,phone,passport_no,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)`;
    await run(wk, [off1, "Maria Santos", 32, "الفلبين", "عاملة منزلية", "00639170001122", "P9921045", "available", today()]);
    await run(wk, [off1, "Aisha Bekele", 28, "إثيوبيا", "عاملة منزلية", null, "ET5512098", "available", today()]);
    await run(wk, [off1, "Rahim Uddin", 35, "بنغلاديش", "سائق خاص", "008801711002233", "BX4410922", "reserved", today()]);
    await run(wk, [off1, "Grace Wanjiru", 30, "كينيا", "عاملة منزلية", null, "KE7781234", "available", today()]);
    await run(wk, [off2, "Lakmali Perera", 29, "سريلانكا", "عاملة منزلية", null, "SL3390011", "available", today()]);
    console.log("✓ تم زرع البيانات التجريبية.");
  }

  // أمان: أي مكتب بلا اشتراك يحصل على فترة تجريبية
  const noSub = await all("SELECT id FROM offices WHERE id NOT IN (SELECT office_id FROM subscriptions)");
  for (const o of noSub) await repo.startTrial(o.id);
}

export default pool;
