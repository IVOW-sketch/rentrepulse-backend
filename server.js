import express from "express";
import cors from "cors";
import cron from "node-cron";
import sgMail from "@sendgrid/mail";
import twilio from "twilio";
import Database from "better-sqlite3";

// ─── DB SETUP ─────────────────────────────────────────────────────────────────
const db = new Database("rentpulse.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idNo TEXT,
    name TEXT NOT NULL,
    dob TEXT,
    unit TEXT,
    email TEXT NOT NULL,
    phone TEXT,
    rentAmount REAL,
    rentDue INTEGER,
    moveIn TEXT,
    status TEXT DEFAULT 'new',
    lastPaid TEXT,
    overdueDays INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenantId INTEGER NOT NULL,
    date TEXT,
    amount REAL,
    months TEXT,
    note TEXT,
    FOREIGN KEY (tenantId) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenantId INTEGER,
    tenantName TEXT,
    type TEXT,
    channel TEXT,
    sentAt TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'sent'
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Insert default settings if not present
const defaultSettings = {
  sendgridKey: "",
  fromEmail: "",
  twilioSid: "",
  twilioToken: "",
  twilioFrom: "",
  whatsappFrom: "",
  reminder21: "true",
  reminder7: "true",
  dueToday: "true",
  overdueMax: "14",
  overdueChannels: JSON.stringify({ email: true, sms: true, whatsapp: true }),
};
for (const [key, value] of Object.entries(defaultSettings)) {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

// ─── MESSAGING HELPERS ────────────────────────────────────────────────────────
function getClients() {
  const sgKey = getSetting("sendgridKey");
  const sid = getSetting("twilioSid");
  const token = getSetting("twilioToken");
  if (sgKey) sgMail.setApiKey(sgKey);
  const twilioClient = sid && token ? twilio(sid, token) : null;
  return { twilioClient };
}

async function sendEmail(to, subject, html) {
  try {
    const fromEmail = getSetting("fromEmail");
    if (!getSetting("sendgridKey") || !fromEmail) return false;
    await sgMail.send({ to, from: fromEmail, subject, html });
    return true;
  } catch (e) {
    console.error("Email error:", e.message);
    return false;
  }
}

async function sendSMS(to, body) {
  try {
    const { twilioClient } = getClients();
    const from = getSetting("twilioFrom");
    if (!twilioClient || !from) return false;
    await twilioClient.messages.create({ to, from, body });
    return true;
  } catch (e) {
    console.error("SMS error:", e.message);
    return false;
  }
}

async function sendWhatsApp(to, body) {
  try {
    const { twilioClient } = getClients();
    const from = getSetting("whatsappFrom");
    if (!twilioClient || !from) return false;
    await twilioClient.messages.create({
      to: `whatsapp:${to}`,
      from,
      body,
    });
    return true;
  } catch (e) {
    console.error("WhatsApp error:", e.message);
    return false;
  }
}

// ─── NOTIFICATION SENDER ──────────────────────────────────────────────────────
const TEMPLATES = {
  welcome: (name, unit, amount) => ({
    subject: `Welcome to ${unit}, ${name}! 🏠`,
    html: `<h2>Welcome, ${name}!</h2><p>We're glad to have you at <b>${unit}</b>. Your monthly rent is <b>$${amount}</b>. You'll receive reminders before each payment is due. Thank you!</p>`,
    sms: `Hi ${name}, welcome to ${unit}! Your monthly rent is $${amount}. We'll remind you before each due date. — RentPulse`,
  }),
  reminder21: (name, unit, amount, dueDate) => ({
    subject: `Rent Reminder — 3 weeks to go, ${name}`,
    html: `<h2>Hi ${name},</h2><p>Just a heads-up — your rent of <b>$${amount}</b> for <b>${unit}</b> is due on <b>${dueDate}</b> (3 weeks from now). Please plan accordingly!</p>`,
    sms: `Hi ${name}, your rent of $${amount} for ${unit} is due on ${dueDate} — 3 weeks away. — RentPulse`,
  }),
  reminder7: (name, unit, amount, dueDate) => ({
    subject: `Rent Reminder — 1 week to go, ${name}`,
    html: `<h2>Hi ${name},</h2><p>Your rent of <b>$${amount}</b> for <b>${unit}</b> is due on <b>${dueDate}</b> — just 1 week away. Please make sure payment is ready!</p>`,
    sms: `Hi ${name}, your rent of $${amount} for ${unit} is due on ${dueDate} — 1 week away. — RentPulse`,
  }),
  dueToday: (name, unit, amount) => ({
    subject: `Your Rent is Due Today, ${name} 🔔`,
    html: `<h2>Hi ${name},</h2><p>Your rent of <b>$${amount}</b> for <b>${unit}</b> is due <b>today</b>. Please make your payment as soon as possible. Thank you!</p>`,
    sms: `Hi ${name}, your rent of $${amount} for ${unit} is DUE TODAY. Please pay as soon as possible. — RentPulse`,
  }),
  overdue: (name, unit, amount, days) => ({
    subject: `⚠️ Rent Overdue — Day ${days}, ${name}`,
    html: `<h2>Hi ${name},</h2><p>Your rent of <b>$${amount}</b> for <b>${unit}</b> is now <b>${days} day(s) overdue</b>. Please make payment immediately to avoid further issues. Contact us if you need assistance.</p>`,
    sms: `⚠️ Hi ${name}, your rent of $${amount} for ${unit} is ${days} day(s) overdue. Please pay immediately. — RentPulse`,
  }),
  confirmed: (name, unit, amount) => ({
    subject: `✅ Payment Confirmed — Thank you, ${name}!`,
    html: `<h2>Hi ${name},</h2><p>We've received your rent payment of <b>$${amount}</b> for <b>${unit}</b>. Thank you! Your next reminder will be sent 3 weeks before your next due date.</p>`,
    sms: `✅ Hi ${name}, we received your rent payment of $${amount} for ${unit}. Thank you! — RentPulse`,
  }),
};

async function sendNotification(tenant, type, channels = ["email"]) {
  const tmpl = TEMPLATES[type];
  if (!tmpl) return;

  const today = new Date();
  const dueDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(tenant.rentDue).padStart(2, "0")}`;
  const content = tmpl(tenant.name, tenant.unit, tenant.rentAmount, dueDate, tenant.overdueDays || 1);

  const results = [];
  if (channels.includes("email"))     results.push(await sendEmail(tenant.email, content.subject, content.html));
  if (channels.includes("sms"))       results.push(await sendSMS(tenant.phone, content.sms));
  if (channels.includes("whatsapp"))  results.push(await sendWhatsApp(tenant.phone, content.sms));

  // Log it
  db.prepare(
    "INSERT INTO notification_log (tenantId, tenantName, type, channel, status) VALUES (?, ?, ?, ?, ?)"
  ).run(tenant.id, tenant.name, type, channels.join(","), "sent");

  return results;
}

// ─── DAILY SCHEDULER ──────────────────────────────────────────────────────────
// Runs every day at 8:00 AM
cron.schedule("0 8 * * *", async () => {
  console.log("⏰ Running daily rent check:", new Date().toISOString());

  const tenants = db.prepare("SELECT * FROM tenants").all();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const overdueChannels = JSON.parse(getSetting("overdueChannels") || "{}");
  const overdueMax = parseInt(getSetting("overdueMax") || "14");

  for (const tenant of tenants) {
    if (tenant.status === "current") continue; // already paid this month

    // Build due date for this month
    const dueDate = new Date(today.getFullYear(), today.getMonth(), tenant.rentDue);
    const diffMs = dueDate - today;
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    // 21 days before
    if (diffDays === 21 && getSetting("reminder21") === "true") {
      await sendNotification(tenant, "reminder21", ["email", "sms", "whatsapp"]);
    }

    // 7 days before
    if (diffDays === 7 && getSetting("reminder7") === "true") {
      await sendNotification(tenant, "reminder7", ["email", "sms", "whatsapp"]);
    }

    // Due today
    if (diffDays === 0 && getSetting("dueToday") === "true") {
      await sendNotification(tenant, "dueToday", ["email", "sms", "whatsapp"]);
      db.prepare("UPDATE tenants SET status = 'dueToday' WHERE id = ?").run(tenant.id);
    }

    // Overdue — every 24hrs
    if (diffDays < 0) {
      const overdueDays = Math.abs(diffDays);
      if (overdueDays <= overdueMax) {
        const channels = Object.entries(overdueChannels)
          .filter(([, v]) => v)
          .map(([k]) => k);
        await sendNotification(tenant, "overdue", channels);
        db.prepare("UPDATE tenants SET status = 'overdue', overdueDays = ? WHERE id = ?")
          .run(overdueDays, tenant.id);
      }
    }
  }

  console.log("✅ Daily check complete");
});

// ─── EXPRESS API ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => res.json({ status: "RentPulse backend running ✅" }));

// ── TENANTS ──
app.get("/tenants", (req, res) => {
  const tenants = db.prepare("SELECT * FROM tenants").all();
  const payments = db.prepare("SELECT * FROM payments").all();
  const result = tenants.map(t => ({
    ...t,
    payments: payments.filter(p => p.tenantId === t.id),
  }));
  res.json(result);
});

app.post("/tenants", async (req, res) => {
  const { idNo, name, dob, unit, email, phone, rentAmount, rentDue, moveIn } = req.body;
  const r = db.prepare(
    "INSERT INTO tenants (idNo, name, dob, unit, email, phone, rentAmount, rentDue, moveIn, status, lastPaid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', '—')"
  ).run(idNo, name, dob, unit, email, phone, rentAmount, rentDue, moveIn);

  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(r.lastInsertRowid);

  // Send welcome message
  await sendNotification(tenant, "welcome", ["email", "sms", "whatsapp"]);

  res.json({ ...tenant, payments: [] });
});

app.put("/tenants/:id", (req, res) => {
  const { idNo, name, dob, unit, email, phone, rentAmount, rentDue, moveIn, status, lastPaid, overdueDays } = req.body;
  db.prepare(
    "UPDATE tenants SET idNo=?, name=?, dob=?, unit=?, email=?, phone=?, rentAmount=?, rentDue=?, moveIn=?, status=?, lastPaid=?, overdueDays=? WHERE id=?"
  ).run(idNo, name, dob, unit, email, phone, rentAmount, rentDue, moveIn, status, lastPaid, overdueDays || 0, req.params.id);
  res.json({ success: true });
});

app.delete("/tenants/:id", (req, res) => {
  db.prepare("DELETE FROM payments WHERE tenantId = ?").run(req.params.id);
  db.prepare("DELETE FROM tenants WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Mark paid
app.post("/tenants/:id/mark-paid", async (req, res) => {
  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(req.params.id);
  if (!tenant) return res.status(404).json({ error: "Not found" });

  const today = new Date().toISOString().split("T")[0];
  db.prepare("UPDATE tenants SET status='current', lastPaid=?, overdueDays=0 WHERE id=?").run(today, tenant.id);

  // Add payment record
  db.prepare("INSERT INTO payments (tenantId, date, amount, months, note) VALUES (?, ?, ?, ?, ?)")
    .run(tenant.id, today, tenant.rentAmount, new Date().toLocaleString("default", { month: "long", year: "numeric" }), "Marked paid via dashboard");

  // Send confirmation
  await sendNotification(tenant, "confirmed", ["email", "sms", "whatsapp"]);

  res.json({ success: true });
});

// Manual notification send
app.post("/tenants/:id/notify", async (req, res) => {
  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(req.params.id);
  if (!tenant) return res.status(404).json({ error: "Not found" });
  const { type, channels } = req.body;
  await sendNotification(tenant, type, channels);
  res.json({ success: true });
});

// ── PAYMENTS ──
app.get("/tenants/:id/payments", (req, res) => {
  const payments = db.prepare("SELECT * FROM payments WHERE tenantId = ? ORDER BY date DESC").all(req.params.id);
  res.json(payments);
});

app.post("/tenants/:id/payments", (req, res) => {
  const { date, amount, months, note } = req.body;
  const r = db.prepare("INSERT INTO payments (tenantId, date, amount, months, note) VALUES (?, ?, ?, ?, ?)")
    .run(req.params.id, date, amount, months, note);
  res.json({ id: r.lastInsertRowid, tenantId: Number(req.params.id), date, amount, months, note });
});

app.put("/payments/:id", (req, res) => {
  const { date, amount, months, note } = req.body;
  db.prepare("UPDATE payments SET date=?, amount=?, months=?, note=? WHERE id=?")
    .run(date, amount, months, note, req.params.id);
  res.json({ success: true });
});

app.delete("/payments/:id", (req, res) => {
  db.prepare("DELETE FROM payments WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ── NOTIFICATION LOG ──
app.get("/notifications", (req, res) => {
  const logs = db.prepare("SELECT * FROM notification_log ORDER BY sentAt DESC LIMIT 100").all();
  res.json(logs);
});

// ── SETTINGS ──
app.get("/settings", (req, res) => {
  const rows = db.prepare("SELECT * FROM settings").all();
  const result = {};
  for (const row of rows) result[row.key] = row.value;
  res.json(result);
});

app.put("/settings", (req, res) => {
  const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(req.body)) {
    stmt.run(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  res.json({ success: true });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🏢 RentPulse backend running on port ${PORT}`));
