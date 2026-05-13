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
  maxHttpBufferSize: 20 * 1024 * 1024, // 20MB for images
});

// Track rooms: roomId -> { phone, pc }
const rooms = {};

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // Phone joins a room
  socket.on("phone:join", ({ roomId }) => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId].phone = socket.id;
    console.log(`Phone joined room: ${roomId}`);
    // Notify PC if already waiting
    io.to(roomId).emit("room:status", { phone: true, pc: !!rooms[roomId]?.pc });
  });

  // PC joins a room
  socket.on("pc:join", ({ roomId }) => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId].pc = socket.id;
    console.log(`PC joined room: ${roomId}`);
    io.to(roomId).emit("room:status", { phone: !!rooms[roomId]?.phone, pc: true });
  });

  // Phone sends captured image → relay to PC
  socket.on("phone:image", ({ roomId, imageData, timestamp }) => {
    console.log(`Image received from phone in room: ${roomId}`);
    io.to(roomId).emit("pc:image_received", { imageData, timestamp });
  });

  // PC sends analysis result → relay to phone
  socket.on("pc:result", ({ roomId, result }) => {
    io.to(roomId).emit("phone:result", { result });
  });

  socket.on("disconnect", () => {
    // Clean up rooms
    for (const [roomId, r] of Object.entries(rooms)) {
      if (r.phone === socket.id) {
        r.phone = null;
        io.to(roomId).emit("room:status", { phone: false, pc: !!r.pc });
      }
      if (r.pc === socket.id) {
        r.pc = null;
        io.to(roomId).emit("room:status", { phone: !!r.phone, pc: false });
      }
    }
    console.log("Disconnected:", socket.id);
  });
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`SHAK server running on port ${PORT}`));
