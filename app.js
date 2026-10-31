const $ = (selector) => document.querySelector(selector);
const roomList = $("#room-list");
const tokenKey = "yappuccino-token";
const userKey = "yappuccino-user";
let currentUser = JSON.parse(localStorage.getItem(userKey) || "null");
let socket;
let currentRoom = "weekly-sync";
let authMode = "login";
let toastTimer;
let meetingStartedAt;
let callTimer;
let isMuted = false;
let localStream;
let screenStream;
let screenTrack;
let boardDrawing = false;
let boardTool = "draw";
const peers = new Map();
const fileRecords = new Map();
const fileRows = new Map();
const canvas = $("#whiteboard-canvas");
const context = canvas.getContext("2d");
const peerConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function safeRoomName(value) {
  return /^[\w-]{3,48}$/.test(value);
}

function setRoom(room) {
  if (!safeRoomName(room)) return notify("Use 3–48 letters, numbers, dashes or underscores.");
  currentRoom = room;
  $("#room-breadcrumb").textContent = room;
  $("#room-list").querySelectorAll(".room-link").forEach((link) => {
    link.classList.toggle("selected", link.dataset.room === room);
  });
  if (!roomList.querySelector(`[data-room="${CSS.escape(room)}"]`)) {
    const button = document.createElement("button");
    button.className = "room-link selected";
    button.dataset.room = room;
    const dot = document.createElement("span");
    dot.className = "room-dot lavender";
    button.append(dot, document.createTextNode(room));
    roomList.append(button);
  }
  for (const [peerId, peer] of peers) {
    peer.connection.close();
    peer.tile.remove();
    peers.delete(peerId);
  }
  $("#waiting-tile").hidden = false;
  clearRoomFiles();
  if (socket?.connected) joinCurrentRoom();
  else if (localStorage.getItem(tokenKey)) connectSocket();
}

function setUser(user) {
  currentUser = user;
  localStorage.setItem(userKey, JSON.stringify(user));
  const name = user?.name || "Your profile";
  const initial = name.slice(0, 1).toUpperCase();
  $("#profile-name").textContent = name;
  $("#profile-status").textContent = user ? "Here for the good ideas" : "Sign in to get started";
  $("#profile-avatar").textContent = initial;
  $("#top-avatar").textContent = initial;
  $("#self-avatar").textContent = initial;
  $("#self-display-name").textContent = user ? `${name} (you)` : "Your camera is off";
  $("#self-tile-name").firstChild.textContent = user ? `${name} (you) ` : "You ";
}

function openAuth(mode = "login") {
  setAuthMode(mode);
  $("#auth-modal").hidden = false;
  $("#auth-error").textContent = "";
  $("#auth-form").elements.email.focus();
}

function closeAuth() {
  $("#auth-modal").hidden = true;
}

function setAuthMode(mode) {
  authMode = mode;
  $("#auth-title").textContent = mode === "register" ? "Make yourself at home." : "Come on in.";
  $("#name-field").hidden = mode !== "register";
  $("#auth-form").elements.name.required = mode === "register";
  $("#auth-form").elements.password.autocomplete = mode === "register" ? "new-password" : "current-password";
  document.querySelectorAll(".auth-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === mode));
}

async function authRequest(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  return result;
}

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector(".auth-submit");
  const body = Object.fromEntries(new FormData(form));
  submit.disabled = true;
  submit.textContent = "One sec…";
  $("#auth-error").textContent = "";
  try {
    const result = await authRequest(`/api/auth/${authMode === "register" ? "register" : "login"}`, body);
    localStorage.setItem(tokenKey, result.token);
    setUser(result.user);
    closeAuth();
    await connectSocket();
    notify(`Welcome ${authMode === "register" ? "to the room" : "back"}, ${result.user.name.split(" ")[0]}!`);
  } catch (error) {
    $("#auth-error").textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.innerHTML = "Let’s go <span>→</span>";
  }
});

function connectSocket() {
  if (!localStorage.getItem(tokenKey)) return openAuth();
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  socket = io({ auth: { token: localStorage.getItem(tokenKey) } });
  socket.on("connect", joinCurrentRoom);
  socket.on("connect_error", (error) => {
    if (error.message.includes("sign in")) {
      localStorage.removeItem(tokenKey);
      setUser(null);
      openAuth("login");
    }
    notify(error.message);
  });
  socket.on("peer-joined", ({ id, user }) => {
    createPeer(id, user, true);
    addActivity(user?.name || "A teammate", "joined the room");
  });
  socket.on("peer-left", ({ id }) => removePeer(id));
  socket.on("offer", ({ from, payload }) => acceptOffer(from, payload));
  socket.on("answer", ({ from, payload }) => acceptAnswer(from, payload));
  socket.on("ice-candidate", ({ from, payload }) => addCandidate(from, payload));
  socket.on("whiteboard-draw", drawRemoteStroke);
  socket.on("whiteboard-clear", clearBoardCanvas);
  socket.on("file-shared", addFile);
}

function joinCurrentRoom() {
  socket.emit("join-room", currentRoom, (result) => {
    if (result.error) return notify(result.error);
    result.peers.forEach((peer) => createPeer(peer.id, peer.user, false));
    $("#waiting-tile").hidden = result.peers.length > 0;
    $("#participant-count").textContent = `${result.peers.length + 1} here`;
    addActivity("You", `joined #${currentRoom}`);
    loadRoomFiles();
    meetingStartedAt ||= Date.now();
    if (!callTimer) callTimer = setInterval(updateMeetingTime, 1000);
  });
}

function updateMeetingTime() {
  if (!meetingStartedAt) return;
  const elapsed = Math.floor((Date.now() - meetingStartedAt) / 1000);
  $("#meeting-time").textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
}

function createPeer(id, user, initiator) {
  if (peers.has(id)) return peers.get(id);
  const connection = new RTCPeerConnection(peerConfiguration);
  const tile = createPeerTile(user);
  const remoteStream = new MediaStream();
  const video = tile.querySelector("video");
  video.srcObject = remoteStream;
  const audioTransceiver = connection.addTransceiver("audio", { direction: "sendrecv" });
  const videoTransceiver = connection.addTransceiver("video", { direction: "sendrecv" });
  const peer = { connection, tile, remoteStream, user, audioTransceiver, videoTransceiver, pendingCandidates: [] };
  peers.set(id, peer);
  $("#waiting-tile").hidden = true;
  audioTransceiver.sender.replaceTrack(localStream?.getAudioTracks()[0] || null);
  videoTransceiver.sender.replaceTrack(screenTrack || localStream?.getVideoTracks()[0] || null);
  connection.ontrack = (event) => {
    event.streams[0]?.getTracks().forEach((track) => remoteStream.addTrack(track));
    if (!event.streams.length) remoteStream.addTrack(event.track);
    if (event.track.kind === "video") {
      event.track.onunmute = () => {
        tile.querySelector(".video-placeholder").hidden = true;
        video.hidden = false;
      };
      event.track.onmute = () => {
        tile.querySelector(".video-placeholder").hidden = false;
        video.hidden = true;
      };
    }
  };
  connection.onicecandidate = (event) => {
    if (event.candidate) socket.emit("ice-candidate", { to: id, payload: event.candidate });
  };
  connection.onconnectionstatechange = () => {
    if (connection.connectionState === "failed") connection.restartIce();
  };
  if (initiator) {
    connection.createOffer().then((offer) => connection.setLocalDescription(offer))
      .then(() => socket.emit("offer", { to: id, payload: connection.localDescription }))
      .catch((error) => notify(`Could not start the call: ${error.message}`));
  }
  $("#participant-count").textContent = `${peers.size + 1} here`;
  return peer;
}

function createPeerTile(user) {
  const tile = document.createElement("div");
  tile.className = "video-tile remote-tile";
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.hidden = true;
  const placeholder = document.createElement("div");
  placeholder.className = "video-placeholder";
  const avatar = document.createElement("span");
  avatar.className = "avatar avatar-peach avatar-large";
  avatar.textContent = user?.name?.slice(0, 1).toUpperCase() || "?";
  const name = document.createElement("strong");
  name.textContent = user?.name || "Teammate";
  const note = document.createElement("small");
  note.textContent = "In the room";
  placeholder.append(avatar, name, note);
  const label = document.createElement("span");
  label.className = "tile-name";
  label.textContent = user?.name || "Teammate";
  tile.append(video, placeholder, label);
  $("#video-grid").prepend(tile);
  return tile;
}

async function acceptOffer(id, offer) {
  const peer = createPeer(id, null, false);
  try {
    await peer.connection.setRemoteDescription(offer);
    await flushCandidates(peer);
    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);
    socket.emit("answer", { to: id, payload: peer.connection.localDescription });
  } catch (error) {
    notify(`Could not connect to a teammate: ${error.message}`);
  }
}

async function acceptAnswer(id, answer) {
  const peer = peers.get(id);
  if (!peer) return;
  try {
    await peer.connection.setRemoteDescription(answer);
    await flushCandidates(peer);
  } catch (error) {
    notify(error.message);
  }
}

async function addCandidate(id, candidate) {
  const peer = peers.get(id);
  if (!peer) return;
  if (!peer.connection.remoteDescription) {
    peer.pendingCandidates.push(candidate);
    return;
  }
  await peer.connection.addIceCandidate(candidate).catch((error) => notify(`Call connection issue: ${error.message}`));
}

async function flushCandidates(peer) {
  for (const candidate of peer.pendingCandidates.splice(0)) {
    await peer.connection.addIceCandidate(candidate).catch((error) => notify(`Call connection issue: ${error.message}`));
  }
}

function removePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.connection.close();
  peer.tile.remove();
  peers.delete(id);
  $("#participant-count").textContent = `${peers.size + 1} here`;
  addActivity(peer.user?.name || "A teammate", "left the room");
  if (peers.size === 0) $("#waiting-tile").hidden = false;
}

async function toggleCamera() {
  const videoTrack = localStream?.getVideoTracks()[0];
  if (videoTrack?.enabled) {
    videoTrack.enabled = false;
    $("#camera-toggle").classList.remove("on");
    $("#camera-toggle").setAttribute("aria-label", "Turn camera on");
    $("#self-placeholder").hidden = false;
    $("#local-video").hidden = true;
    peers.forEach(({ videoTransceiver }) => videoTransceiver.sender.replaceTrack(null));
    return;
  }
  try {
    await ensureMedia("video");
    const activeTrack = localStream.getVideoTracks()[0];
    if (activeTrack) activeTrack.enabled = true;
    $("#local-video").srcObject = localStream;
    $("#local-video").hidden = false;
    $("#self-placeholder").hidden = true;
    $("#camera-toggle").classList.add("on");
    $("#camera-toggle").setAttribute("aria-label", "Turn camera off");
    $("#self-tile-tag").hidden = true;
    peers.forEach(({ videoTransceiver }) => videoTransceiver.sender.replaceTrack(screenTrack || activeTrack || null));
  } catch (error) {
    notify(error.name === "NotAllowedError" ? "Allow camera access in your browser to turn it on." : `Could not access your camera: ${error.message}`);
  }
}

async function toggleMic() {
  const audioTrack = localStream?.getAudioTracks()[0];
  if (!audioTrack || !audioTrack.enabled) {
    try {
      await ensureMedia("audio");
    } catch (error) {
      return notify(error.name === "NotAllowedError" ? "Allow microphone access in your browser to unmute." : `Could not access your microphone: ${error.message}`);
    }
    isMuted = false;
  } else {
    isMuted = true;
  }
  const activeTrack = localStream.getAudioTracks()[0];
  if (activeTrack) activeTrack.enabled = !isMuted;
  $("#mic-toggle").classList.toggle("on", isMuted);
  $("#mic-toggle").setAttribute("aria-label", isMuted ? "Unmute microphone" : "Mute microphone");
  $("#mic-toggle").querySelector("small").textContent = isMuted ? "Unmute" : "Mute";
  $("#self-mic-indicator").textContent = isMuted ? "×" : "♫";
  $("#self-mic-indicator").classList.toggle("muted", isMuted);
}

async function ensureMedia(kind) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera and microphone access requires HTTPS or localhost.");
  const needAudio = kind === "audio" && !localStream?.getAudioTracks().length;
  const needVideo = kind === "video" && !localStream?.getVideoTracks().length;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: needAudio, video: needVideo });
  localStream ||= new MediaStream();
  stream.getTracks().forEach((track) => {
    localStream.addTrack(track);
    peers.forEach((peer) => {
      const transceiver = track.kind === "audio" ? peer.audioTransceiver : peer.videoTransceiver;
      transceiver.sender.replaceTrack(track);
    });
  });
  $("#local-video").srcObject = localStream;
}

async function toggleShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) return notify("Screen sharing is not available in this browser.");
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    screenTrack = screenStream.getVideoTracks()[0];
    screenTrack.onended = stopSharing;
    const video = document.createElement("video");
    video.className = "screen-share-preview";
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = screenStream;
    const label = document.createElement("span");
    label.className = "tile-name";
    label.textContent = `${currentUser?.name || "You"}’s screen`;
    const tile = document.createElement("div");
    tile.className = "video-tile screen-share-tile";
    tile.append(video, label);
    $("#video-grid").prepend(tile);
    tile.dataset.localShare = "true";
    $("#share-toggle").classList.add("on");
    peers.forEach(({ videoTransceiver }) => videoTransceiver.sender.replaceTrack(screenTrack));
    notify("You’re sharing your screen. Good stuff!");
  } catch (error) {
    if (error.name !== "NotAllowedError") notify(`Could not share your screen: ${error.message}`);
  }
}

function stopSharing() {
  $("#video-grid").querySelector('[data-local-share="true"]')?.remove();
  screenStream?.getTracks().forEach((track) => track.stop());
  screenStream = null;
  screenTrack = null;
  const camera = localStream?.getVideoTracks()[0];
  peers.forEach(({ videoTransceiver }) => videoTransceiver.sender.replaceTrack(camera?.enabled ? camera : null));
  $("#share-toggle").classList.remove("on");
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const snapshot = document.createElement("canvas");
  snapshot.width = canvas.width;
  snapshot.height = canvas.height;
  snapshot.getContext("2d").drawImage(canvas, 0, 0);
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (snapshot.width && snapshot.height) context.drawImage(snapshot, 0, 0, rect.width, rect.height);
}

function strokeFromPointer(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
    color: boardTool === "erase" ? "#fcfbfd" : $("#board-color").value,
    width: boardTool === "erase" ? 16 : 3.5,
    room: currentRoom
  };
}

function paintStroke(from, to, emit = false) {
  const rect = canvas.getBoundingClientRect();
  context.beginPath();
  context.moveTo(from.x * rect.width, from.y * rect.height);
  context.lineTo(to.x * rect.width, to.y * rect.height);
  context.strokeStyle = to.color;
  context.lineWidth = to.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.stroke();
  if (emit && socket?.connected) socket.emit("whiteboard-draw", { from, to });
}

let previousPoint;
canvas.addEventListener("pointerdown", (event) => {
  boardDrawing = true;
  previousPoint = strokeFromPointer(event);
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!boardDrawing) return;
  const point = strokeFromPointer(event);
  paintStroke(previousPoint, point, true);
  previousPoint = point;
});
canvas.addEventListener("pointerup", () => { boardDrawing = false; previousPoint = null; });
canvas.addEventListener("pointercancel", () => { boardDrawing = false; previousPoint = null; });

function drawRemoteStroke(stroke) {
  if (stroke.room !== currentRoom || !stroke.from || !stroke.to) return;
  paintStroke(stroke.from, stroke.to);
}

function clearBoardCanvas() {
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function setBoardTool(tool) {
  boardTool = tool;
  document.querySelectorAll(".board-tool[data-tool]").forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
}

function renderFile(file) {
  fileRecords.set(file.id, file);
  $("#file-count").textContent = String(fileRecords.size);
  $("#file-list").querySelector(".empty-files")?.remove();
  if (fileRows.has(file.id)) return;
  const row = document.createElement("div");
  row.className = "file-row";
  const icon = document.createElement("span");
  icon.className = "file-kind";
  icon.textContent = file.name.split(".").pop().slice(0, 4).toUpperCase();
  const info = document.createElement("span");
  info.className = "file-info";
  const name = document.createElement("strong");
  name.textContent = file.name;
  const detail = document.createElement("small");
  detail.textContent = `${(file.size / 1024).toFixed(file.size >= 1024 * 1024 ? 1 : 0)} ${file.size >= 1024 * 1024 ? "MB" : "KB"} · ${file.uploadedBy?.name || "A teammate"}`;
  info.append(name, detail);
  const download = document.createElement("a");
  download.className = "download-link";
  download.href = `/api/files/${encodeURIComponent(file.id)}`;
  download.textContent = "↓";
  download.setAttribute("aria-label", `Download ${file.name}`);
  download.addEventListener("click", (event) => {
    event.preventDefault();
    downloadFile(file);
  });
  row.append(icon, info, download);
  $("#file-list").prepend(row);
  fileRows.set(file.id, row);
}

function addFile(file) {
  if (file.room && file.room !== currentRoom) return;
  renderFile(file);
  addActivity(file.uploadedBy?.name || "A teammate", `shared ${file.name}`);
  notify(`${file.uploadedBy?.name || "A teammate"} shared ${file.name}`);
}

function addActivity(actor, action) {
  const item = document.createElement("div");
  item.className = "activity-event";
  const avatar = document.createElement("span");
  avatar.className = "activity-avatar avatar-lavender";
  avatar.textContent = actor.slice(0, 1).toUpperCase();
  const detail = document.createElement("div");
  const description = document.createElement("p");
  const name = document.createElement("strong");
  name.textContent = actor;
  description.append(name, document.createTextNode(` ${action}`));
  const time = document.createElement("time");
  time.textContent = "just now";
  detail.append(description, time);
  item.append(avatar, detail);
  $("#activity-feed").append(item);
}

function clearRoomFiles() {
  fileRecords.clear();
  fileRows.clear();
  $("#file-list").replaceChildren();
  $("#file-list").append(Object.assign(document.createElement("div"), {
    className: "empty-files",
    textContent: "Files shared in this room will show up here."
  }));
  $("#file-count").textContent = "0";
}

async function loadRoomFiles() {
  try {
    const response = await fetch(`/api/files?room=${encodeURIComponent(currentRoom)}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem(tokenKey)}` }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load this room’s files.");
    result.files.forEach(renderFile);
  } catch (error) {
    notify(error.message);
  }
}

function downloadFile(file) {
  fetch(`/api/files/${encodeURIComponent(file.id)}`, { headers: { Authorization: `Bearer ${localStorage.getItem(tokenKey)}` } })
    .then(async (response) => {
      if (!response.ok) throw new Error("Could not download that file.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      link.click();
      URL.revokeObjectURL(url);
    })
    .catch((error) => notify(error.message));
}

async function uploadFiles(files) {
  if (!localStorage.getItem(tokenKey)) return openAuth();
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) {
      notify(`${file.name} is too big. Files can be up to 10 MB.`);
      continue;
    }
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
        reader.readAsDataURL(file);
      });
      const response = await fetch("/api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem(tokenKey)}` },
        body: JSON.stringify({ name: file.name, type: file.type, data, room: currentRoom })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Could not share ${file.name}.`);
      renderFile(result.file);
      notify(`${file.name} is on the table!`);
    } catch (error) {
      notify(error.message);
    }
  }
}

async function invitePeople() {
  const url = new URL(location.href);
  url.searchParams.set("room", currentRoom);
  try {
    await navigator.clipboard.writeText(url.toString());
    notify("Room link copied. Pass it to a teammate!");
  } catch {
    window.prompt("Copy this room link and send it to a teammate:", url.toString());
  }
}

$("#mic-toggle").addEventListener("click", toggleMic);
$("#camera-toggle").addEventListener("click", toggleCamera);
$("#share-toggle").addEventListener("click", toggleShare);
$("#board-toggle").addEventListener("click", () => {
  $("#board").scrollIntoView({ behavior: "smooth", block: "center" });
  canvas.focus();
});
$("#files-toggle").addEventListener("click", () => $("#file-input").click());
$("#upload-button").addEventListener("click", () => $("#file-input").click());
$("#browse-files").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (event) => {
  uploadFiles([...event.target.files]);
  event.target.value = "";
});
$("#file-drop").addEventListener("dragover", (event) => {
  event.preventDefault();
  event.currentTarget.classList.add("dragging");
});
$("#file-drop").addEventListener("dragleave", (event) => event.currentTarget.classList.remove("dragging"));
$("#file-drop").addEventListener("drop", (event) => {
  event.preventDefault();
  event.currentTarget.classList.remove("dragging");
  uploadFiles([...event.dataTransfer.files]);
});
$("#copy-room").addEventListener("click", invitePeople);
$("#invite-button").addEventListener("click", invitePeople);
$("#invite-link").addEventListener("click", invitePeople);
$("#leave-button").addEventListener("click", () => {
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  stopSharing();
  socket?.disconnect();
  clearInterval(callTimer);
  callTimer = null;
  meetingStartedAt = null;
  $("#meeting-time").textContent = "00:00";
  $("#local-video").hidden = true;
  $("#self-placeholder").hidden = false;
  $("#camera-toggle").classList.remove("on");
  $("#mic-toggle").classList.remove("on");
  $("#mic-toggle").setAttribute("aria-label", "Mute microphone");
  $("#mic-toggle").querySelector("small").textContent = "Mute";
  $("#self-mic-indicator").textContent = "♫";
  $("#self-mic-indicator").classList.remove("muted");
  isMuted = false;
  peers.forEach((peer, id) => removePeer(id));
  $("#waiting-tile").hidden = false;
  notify("You stepped out of the room.");
});
$("#profile-button").addEventListener("click", () => {
  if (!currentUser) return openAuth();
  socket?.disconnect();
  localStream?.getTracks().forEach((track) => track.stop());
  stopSharing();
  peers.forEach((peer, id) => removePeer(id));
  clearInterval(callTimer);
  callTimer = null;
  meetingStartedAt = null;
  $("#meeting-time").textContent = "00:00";
  $("#local-video").hidden = true;
  $("#self-placeholder").hidden = false;
  $("#waiting-tile").hidden = false;
  $("#camera-toggle").classList.remove("on");
  $("#share-toggle").classList.remove("on");
  clearRoomFiles();
  clearBoardCanvas();
  localStream = null;
  screenStream = null;
  screenTrack = null;
  localStorage.removeItem(tokenKey);
  localStorage.removeItem(userKey);
  setUser(null);
  notify("You’ve signed out. See you soon!");
});
$("#top-avatar").addEventListener("click", () => currentUser ? notify(`Signed in as ${currentUser.email}`) : openAuth());
$("#workspace-switch").addEventListener("click", () => notify("This is your cozy little workspace."));
$("#help-button").addEventListener("click", () => notify("Tip: invite a teammate, turn on your camera, and start making things."));
$("#more-button").addEventListener("click", () => notify("Your room is ready for whatever you bring to it."));
$("#activity-options").addEventListener("click", () => notify("Showing the latest room activity."));
$("#add-room").addEventListener("click", () => {
  const room = window.prompt("Give your new room a name (letters, numbers, dashes, underscores):");
  if (room) setRoom(room.trim().toLowerCase().replace(/\s+/g, "-"));
});
roomList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-room]");
  if (button) setRoom(button.dataset.room);
});
document.querySelectorAll(".auth-tab").forEach((tab) => tab.addEventListener("click", () => setAuthMode(tab.dataset.mode)));
document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeAuth));
$("#auth-modal").addEventListener("click", (event) => {
  if (event.target === $("#auth-modal")) closeAuth();
});
document.querySelectorAll(".board-tool[data-tool]").forEach((button) => button.addEventListener("click", () => setBoardTool(button.dataset.tool)));
$("#clear-board").addEventListener("click", () => {
  clearBoardCanvas();
  if (socket?.connected) socket.emit("whiteboard-clear");
});
$("#board-expand").addEventListener("click", () => {
  $("#board").scrollIntoView({ behavior: "smooth", block: "center" });
  notify("Your shared board is ready for a little doodle.");
});
$("#empty-invite").addEventListener("click", invitePeople);
$("#board-color").addEventListener("input", () => setBoardTool("draw"));
window.addEventListener("resize", resizeCanvas);
window.addEventListener("beforeunload", () => {
  localStream?.getTracks().forEach((track) => track.stop());
  screenStream?.getTracks().forEach((track) => track.stop());
});

async function initialize() {
  const requestedRoom = new URLSearchParams(location.search).get("room");
  if (requestedRoom && safeRoomName(requestedRoom)) setRoom(requestedRoom);
  setUser(currentUser);
  resizeCanvas();
  if (!localStorage.getItem(tokenKey)) return openAuth("register");
  try {
    const response = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${localStorage.getItem(tokenKey)}` } });
    if (!response.ok) throw new Error("Your sign-in expired. Please sign in again.");
    const result = await response.json();
    setUser(result.user);
    connectSocket();
  } catch (error) {
    localStorage.removeItem(tokenKey);
    localStorage.removeItem(userKey);
    setUser(null);
    openAuth("login");
    notify(error.message);
  }
}

initialize();
