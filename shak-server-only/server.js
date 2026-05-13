const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 20 * 1024 * 1024,
});

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

async function callClaude(messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.map(b => b.text || "").join("").trim();
}

app.post("/analyze", async (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: "No image" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set on server" });
  try {
    const base64 = imageData.split(",")[1];
    const ocrText = await callClaude([{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
        { type: "text", text: 'Extract SYS, DIA, PULSE from this Beurer BP monitor photo. Return ONLY JSON: {"sys":120,"dia":80,"pulse":72}. Integers only. No other text.' }
      ]
    }]);
    const readings = JSON.parse(ocrText.replace(/```json|```/g, "").trim());
    if (!readings.sys || !readings.dia || !readings.pulse) throw new Error("Could not read all values");
    const cat = classifyBP(readings.sys, readings.dia);
    const advice = await callClaude([{
      role: "user",
      content: `SHAK Health Kiosk advisor. Patient: SYS ${readings.sys}, DIA ${readings.dia}, Pulse ${readings.pulse} bpm. Classification: ${cat.label}. Write 3 sentences: what it means, what to do, urgency of doctor visit. Warm, professional, no bullets.`
    }]);
    res.json({ readings, category: cat, advice });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

function classifyBP(sys, dia) {
  if (sys < 90 || dia < 60) return { label: "Low Blood Pressure", urgency: "low", color: "#60a5fa", emoji: "💙" };
  if (sys >= 180 || dia >= 120) return { label: "Hypertensive Crisis", urgency: "critical", color: "#dc2626", emoji: "🚨" };
  if (sys >= 140 || dia >= 90) return { label: "High — Stage 2", urgency: "high", color: "#ef4444", emoji: "🔴" };
  if (sys >= 130 || dia >= 80) return { label: "High — Stage 1", urgency: "elevated", color: "#f97316", emoji: "🔶" };
  if (sys >= 121) return { label: "Elevated", urgency: "watch", color: "#facc15", emoji: "⚠️" };
  return { label: "Normal", urgency: "normal", color: "#22c55e", emoji: "✅" };
}

const rooms = {};
io.on("connection", (socket) => {
  socket.on("phone:join", ({ roomId }) => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId].phone = socket.id;
    io.to(roomId).emit("room:status", { phone: true, pc: !!rooms[roomId]?.pc });
  });
  socket.on("pc:join", ({ roomId }) => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId].pc = socket.id;
    io.to(roomId).emit("room:status", { phone: !!rooms[roomId]?.phone, pc: true });
  });
  socket.on("phone:image", ({ roomId, imageData, timestamp }) => {
    io.to(roomId).emit("pc:image_received", { imageData, timestamp });
  });
  socket.on("pc:result", ({ roomId, result }) => {
    io.to(roomId).emit("phone:result", { result });
  });
  socket.on("disconnect", () => {
    for (const [rid, r] of Object.entries(rooms)) {
      if (r.phone === socket.id) { r.phone = null; io.to(rid).emit("room:status", { phone: false, pc: !!r.pc }); }
      if (r.pc === socket.id) { r.pc = null; io.to(rid).emit("room:status", { phone: !!r.phone, pc: false }); }
    }
  });
});

app.get("/health", (_, res) => res.json({ status: "ok", apiKeySet: !!ANTHROPIC_KEY }));
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`SHAK server on port ${PORT}`));
