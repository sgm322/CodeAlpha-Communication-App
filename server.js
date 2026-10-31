const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const http = require("node:http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const requestedPort = Number(process.env.PORT) || 3000;
const useFallbackPorts = !process.env.PORT;
const secret = process.env.APP_SECRET || crypto.randomBytes(32).toString("hex");
const dataDirectory = path.join(__dirname, "data");
const uploadDirectory = path.join(__dirname, "uploads");
const usersFile = path.join(dataDirectory, "users.json");
const filesFile = path.join(dataDirectory, "files.json");
const roomsBySocket = new Map();
const authAttempts = new Map();

fs.mkdirSync(dataDirectory, { recursive: true });
fs.mkdirSync(uploadDirectory, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function signToken(user) {
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function userFromToken(token) {
  if (typeof token !== "string") return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims.sub || claims.exp <= Date.now()) return null;
    return readJson(usersFile, []).find((user) => user.id === claims.sub) || null;
  } catch {
    return null;
  }
}

function requireUser(request, response, next) {
  const token = request.get("authorization")?.replace(/^Bearer\s+/i, "");
  const user = userFromToken(token);
  if (!user) return response.status(401).json({ error: "Please sign in to continue." });
  request.user = user;
  next();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expectedHex] = storedHash.split(":");
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

app.use(express.json({ limit: "14mb" }));
app.use("/api", (request, response, next) => {
  if (!["POST", "PUT", "PATCH"].includes(request.method)) return next();
  if (request.body === undefined) request.body = {};
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    return response.status(400).json({ error: "Send a JSON object with your request." });
  }
  next();
});
app.get("/", (request, response) => response.sendFile(path.join(__dirname, "index.html")));
app.get("/styles.css", (request, response) => response.sendFile(path.join(__dirname, "styles.css")));
app.get("/app.js", (request, response) => response.sendFile(path.join(__dirname, "app.js")));

function limitAuthAttempts(request, response, next) {
  const now = Date.now();
  const key = request.ip;
  const recentAttempts = (authAttempts.get(key) || []).filter((timestamp) => now - timestamp < 15 * 60 * 1000);
  if (recentAttempts.length >= 12) {
    response.set("Retry-After", String(Math.ceil((recentAttempts[0] + 15 * 60 * 1000 - now) / 1000)));
    return response.status(429).json({ error: "Too many sign-in attempts. Please try again later." });
  }
  recentAttempts.push(now);
  authAttempts.set(key, recentAttempts);
  next();
}

app.post("/api/auth/register", limitAuthAttempts, (request, response) => {
  const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
  const email = normalizeEmail(request.body.email);
  const password = request.body.password;
  if (name.length < 2 || name.length > 60 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response.status(400).json({ error: "Enter a name and a valid email address." });
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return response.status(400).json({ error: "Your password must be 8–128 characters." });
  }
  const users = readJson(usersFile, []);
  if (users.some((user) => user.email === email)) {
    return response.status(409).json({ error: "An account with that email already exists." });
  }
  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: hashPassword(password)
  };
  users.push(user);
  writeJson(usersFile, users);
  response.status(201).json({ user: publicUser(user), token: signToken(user) });
});

app.post("/api/auth/login", limitAuthAttempts, (request, response) => {
  const email = normalizeEmail(request.body.email);
  const password = request.body.password;
  const user = readJson(usersFile, []).find((entry) => entry.email === email);
  if (!user || typeof password !== "string" || !verifyPassword(password, user.passwordHash)) {
    return response.status(401).json({ error: "That email and password don’t match." });
  }
  response.json({ user: publicUser(user), token: signToken(user) });
});

app.get("/api/auth/me", requireUser, (request, response) => {
  response.json({ user: publicUser(request.user) });
});

app.post("/api/files", requireUser, (request, response) => {
  const { name, type, data, room } = request.body;
  if (typeof room !== "string" || !/^[\w-]{3,48}$/.test(room)) {
    return response.status(400).json({ error: "Choose a valid room before sharing a file." });
  }
  const isRoomMember = [...io.sockets.sockets.values()].some((socket) =>
    socket.data.user?.id === request.user.id && socket.rooms.has(room));
  if (!isRoomMember) return response.status(403).json({ error: "Join this room before sharing a file." });
  if (typeof name !== "string" || !name.trim() || name.length > 180) {
    return response.status(400).json({ error: "Choose a file with a valid name." });
  }
  if (typeof data !== "string" || !/^data:[^;,]+;base64,/.test(data)) {
    return response.status(400).json({ error: "The uploaded file could not be read." });
  }
  const encoded = data.slice(data.indexOf(",") + 1);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return response.status(400).json({ error: "The uploaded file is not valid base64 data." });
  }
  if (encoded.length > 10 * 1024 * 1024 * 4 / 3 + 8) {
    return response.status(413).json({ error: "Files must be 10 MB or smaller." });
  }
  const content = Buffer.from(encoded, "base64");
  if (!content.length || content.length > 10 * 1024 * 1024) {
    return response.status(413).json({ error: "Files must be between 1 byte and 10 MB." });
  }
  const id = crypto.randomUUID();
  const safeType = typeof type === "string" && type.length <= 120 ? type : "application/octet-stream";
  fs.writeFileSync(path.join(uploadDirectory, id), content, { flag: "wx", mode: 0o600 });
  const files = readJson(filesFile, []);
  const file = {
    id,
    name: path.basename(name.trim()),
    type: safeType,
    size: content.length,
    room,
    uploadedBy: publicUser(request.user),
    createdAt: Date.now()
  };
  files.push(file);
  writeJson(filesFile, files);
  io.to(room).emit("file-shared", file);
  response.status(201).json({ file });
});

app.get("/api/files", requireUser, (request, response) => {
  const room = request.query.room;
  if (typeof room !== "string" || !/^[\w-]{3,48}$/.test(room)) {
    return response.status(400).json({ error: "Choose a valid room to view its files." });
  }
  const isRoomMember = [...io.sockets.sockets.values()].some((socket) =>
    socket.data.user?.id === request.user.id && socket.rooms.has(room));
  if (!isRoomMember) return response.status(403).json({ error: "Join this room to view its files." });
  response.json({
    files: readJson(filesFile, [])
      .filter((file) => file.room === room)
      .sort((first, second) => second.createdAt - first.createdAt)
  });
});

app.get("/api/files/:id", requireUser, (request, response) => {
  const file = readJson(filesFile, []).find((entry) => entry.id === request.params.id);
  if (!file) return response.status(404).json({ error: "That file is no longer available." });
  const isRoomMember = [...io.sockets.sockets.values()].some((socket) =>
    socket.data.user?.id === request.user.id && socket.rooms.has(file.room));
  if (!isRoomMember) return response.status(403).json({ error: "Join this room to download its files." });
  response.download(path.join(uploadDirectory, file.id), file.name);
});

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error("Please sign in to join a call."));
  socket.data.user = publicUser(user);
  next();
});

io.on("connection", (socket) => {
  socket.on("join-room", (roomValue, acknowledge = () => {}) => {
    const room = typeof roomValue === "string" ? roomValue.trim() : "";
    if (!/^[\w-]{3,48}$/.test(room)) {
      return acknowledge({ error: "Room names must be 3–48 letters, numbers, dashes or underscores." });
    }
    const previousRoom = roomsBySocket.get(socket.id);
    if (previousRoom) {
      socket.to(previousRoom).emit("peer-left", { id: socket.id });
      socket.leave(previousRoom);
    }
    const peers = [...(io.sockets.adapter.rooms.get(room) || [])]
      .filter((id) => id !== socket.id)
      .map((id) => ({ id, user: io.sockets.sockets.get(id)?.data.user }));
    socket.join(room);
    roomsBySocket.set(socket.id, room);
    acknowledge({ room, peers });
    socket.to(room).emit("peer-joined", { id: socket.id, user: socket.data.user });
  });

  for (const event of ["offer", "answer", "ice-candidate"]) {
    socket.on(event, ({ to, payload } = {}) => {
      const room = roomsBySocket.get(socket.id);
      if (room && typeof to === "string" && io.sockets.sockets.get(to)?.rooms.has(room)) {
        io.to(to).emit(event, { from: socket.id, payload });
      }
    });
  }

  socket.on("whiteboard-draw", (stroke) => {
    const room = roomsBySocket.get(socket.id);
    const validPoint = (point) => point
      && Number.isFinite(point.x) && point.x >= 0 && point.x <= 1
      && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1
      && /^#[\da-f]{6}$/i.test(point.color)
      && Number.isFinite(point.width) && point.width >= 1 && point.width <= 16;
    if (room && validPoint(stroke?.from) && validPoint(stroke?.to)) {
      socket.to(room).emit("whiteboard-draw", { from: stroke.from, to: stroke.to, room });
    }
  });

  socket.on("whiteboard-clear", () => {
    const room = roomsBySocket.get(socket.id);
    if (room) socket.to(room).emit("whiteboard-clear");
  });

  socket.on("disconnect", () => {
    const room = roomsBySocket.get(socket.id);
    if (room) socket.to(room).emit("peer-left", { id: socket.id });
    roomsBySocket.delete(socket.id);
  });
});

function listen(port) {
  const onError = (error) => {
    server.removeListener("error", onError);
    if (error.code === "EADDRINUSE" && useFallbackPorts && port < 3010) {
      console.warn(`Port ${port} is already in use; trying port ${port + 1}.`);
      listen(port + 1);
      return;
    }
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Choose another port, for example: $env:PORT=3001; npm start`);
    } else {
      console.error(`Could not start Yappuccino: ${error.message}`);
    }
    process.exitCode = 1;
  };

  server.once("error", onError);
  server.listen(port, () => {
    server.removeListener("error", onError);
    console.log(`Yappuccino is ready at http://localhost:${server.address().port}`);
  });
}

listen(requestedPort);
