const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const twilio = require("twilio");

admin.initializeApp();
const TWILIO_ACCOUNT_SID = defineSecret("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = defineSecret("TWILIO_AUTH_TOKEN");
const TWILIO_FROM_NUMBER = defineSecret("TWILIO_FROM_NUMBER");

function cors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function calculateNet(members, expenses) {
  const net = Object.fromEntries(members.map(m => [m.id, 0]));
  for (const e of expenses) {
    if (!(e.payerId in net)) continue;
    net[e.payerId] += Number(e.amount || 0);
    const included = (e.participantIds || []).filter(id => id in net);
    if (!included.length) continue;
    const share = Number(e.amount || 0) / included.length;
    included.forEach(id => net[id] -= share);
  }
  return net;
}

exports.notifyExpense = onRequest({
  secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER],
  region: "us-central1"
}, async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { tripKey, expenseId } = req.body || {};
    if (!tripKey || !expenseId) return res.status(400).json({ error: "tripKey and expenseId required" });

    const db = admin.firestore();
    const tripSnap = await db.doc(`trips/${tripKey}`).get();
    const expenseSnap = await db.doc(`trips/${tripKey}/expenses/${expenseId}`).get();
    const memberSnap = await db.collection(`trips/${tripKey}/members`).get();
    const expenseListSnap = await db.collection(`trips/${tripKey}/expenses`).get();
    if (!tripSnap.exists || !expenseSnap.exists) return res.status(404).json({ error: "Trip or expense not found" });

    const trip = tripSnap.data();
    const expense = expenseSnap.data();
    const members = memberSnap.docs.map(d => d.data());
    const expenses = expenseListSnap.docs.map(d => d.data());
    const payer = members.find(m => m.id === expense.payerId);
    const net = calculateNet(members, expenses);
    const client = twilio(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
    const currency = trip.currency || "USD";
    const fmt = n => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Math.abs(n));
    const tripUrl = `https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO/?trip=${encodeURIComponent(tripKey)}`;

    const recipients = members.filter(m => m.id !== expense.payerId && m.phone);
    const results = await Promise.allSettled(recipients.map(m => {
      const position = net[m.id] || 0;
      const status = position < -0.005 ? `You currently owe ${fmt(position)}.` : position > 0.005 ? `You are owed ${fmt(position)}.` : "You are settled up.";
      const body = `${trip.name}: ${payer?.name || "Someone"} paid ${fmt(expense.amount)} for ${expense.description}. ${status} View: ${tripUrl}`;
      return client.messages.create({ body, from: TWILIO_FROM_NUMBER.value(), to: m.phone });
    }));

    const sent = results.filter(r => r.status === "fulfilled").length;
    const failed = results.length - sent;
    return res.json({ sent, failed });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Notification failed" });
  }
});
