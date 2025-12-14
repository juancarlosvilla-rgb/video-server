/**
 * video-server
 *
 * Small signaling server combining:
 * - Express           → HTTP / health endpoints
 * - Socket.IO         → room membership and peer list
 * - PeerJS            → WebRTC signaling for video streams
 *
 * This server is used by the ChatTeam client for *video* calls.
 */

require("dotenv").config();

const express = require("express") as typeof import("express");
const http = require("http") as typeof import("http");
const cors = require("cors") as typeof import("cors");
const { Server } = require("socket.io") as typeof import("socket.io");
const { ExpressPeerServer } = require("peer") as typeof import("peer");

/**
 * Represents a connected user in a video room.
 *
 * @typedef {Object} VideoUser
 * @property {string} uid    - Application user id.
 * @property {string} name   - Human readable display name.
 * @property {string} peerId - PeerJS peer identifier used for WebRTC.
 */
type VideoUser = { uid: string; name: string; peerId: string };

/**
 * Acknowledge type returned to a client when attempting to join a video room.
 *
 * - ok: true  → peers: current room users
 * - ok: false → error: optional error code
 */
type VideoJoinAck =
  | { ok: true; peers: VideoUser[] }
  | { ok: false; error?: "BAD_REQUEST" };

/**
 * Normalize room id to uppercase trimmed string.
 *
 * @param {unknown} id - Incoming room id (any type).
 * @returns {string} Normalized room id or empty string when invalid.
 */
function normRoomId(id: unknown): string {
  return String(id || "").trim().toUpperCase();
}

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 4020);

/**
 * Read allowed origins from env var CLIENT_ORIGIN.
 * Example:
 *   CLIENT_ORIGIN=http://localhost:5173,https://chat-team-two.vercel.app
 */
const rawOrigins =
  process.env.CLIENT_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173";

const allowedOrigins = rawOrigins
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);

/**
 * Checks whether a given Origin header is allowed to access this server.
 *
 * Rules:
 * - undefined origin (curl/Postman) → allowed
 * - explicit origins listed in CLIENT_ORIGIN → allowed
 * - localhost / 127.0.0.1 with any port → allowed
 */
function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true; // curl / Postman
  if (allowedOrigins.includes("*")) return true;
  if (allowedOrigins.includes(origin)) return true;

  if (origin.startsWith("http://localhost:")) return true;
  if (origin.startsWith("http://127.0.0.1:")) return true;

  return false;
}

// Middleware: CORS + JSON parsing
app.use(
  cors({
    origin: (
      origin: string | undefined,
      cb: (err: Error | null, ok?: boolean) => void
    ) => {
      if (isAllowedOrigin(origin)) cb(null, true);
      else cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json());

/**
 * Health check endpoint.
 */
app.get(
  "/health",
  (_req: import("express").Request, res: import("express").Response) => {
    res.json({ ok: true, service: "video-server" });
  }
);

/**
 * Root endpoint so that Render / browser does not show "Cannot GET /".
 */
app.get(
  "/",
  (_req: import("express").Request, res: import("express").Response) => {
    res.status(200).send("video-server up");
  }
);

/**
 * PeerJS server (WebRTC signaling).
 *
 * IMPORTANT:
 * - We mount at /peerjs in Express
 * - The internal PeerJS `path` is "/" so the final URL is:
 *     <BASE_URL>/peerjs
 *   which matches the client config that uses `path: "/peerjs"`.
 */
const peerServer = ExpressPeerServer(server, {
  path: "/", // <- clave para evitar /peerjs/peerjs
});
app.use("/peerjs", peerServer);

/**
 * Socket.IO server (room membership + peer list)
 */
const io = new Server(server, {
  cors: {
    origin: (
      origin: string | undefined,
      cb: (err: Error | null, ok?: boolean) => void
    ) => {
      if (isAllowedOrigin(origin)) cb(null, true);
      else cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  },
});

/**
 * rooms map structure:
 *   Map<roomId, Map<uid, VideoUser>>
 *
 * It stores the in-memory membership lists.
 */
const rooms = new Map<string, Map<string, VideoUser>>();

io.on("connection", (socket: any) => {
  /**
   * Handle "video:join" event from client.
   *
   * Payload: { roomId, uid, name, peerId }
   * Ack: { ok: true, peers } | { ok: false, error }
   */
  socket.on(
    "video:join",
    (
      payload: { roomId: string; uid: string; name: string; peerId: string },
      ack?: (res: VideoJoinAck) => void
    ) => {
      const rid = normRoomId(payload?.roomId);
      const uid = String(payload?.uid || "").trim();
      const name = String(payload?.name || "").trim() || "Guest";
      const peerId = String(payload?.peerId || "").trim();

      if (!rid || !uid || !peerId) {
        return ack?.({ ok: false, error: "BAD_REQUEST" });
      }

      const map = rooms.get(rid) ?? new Map<string, VideoUser>();
      map.set(uid, { uid, name, peerId });
      rooms.set(rid, map);

      socket.join(rid);
      socket.data.rid = rid;
      socket.data.uid = uid;

      const peers = Array.from(map.values());
      ack?.({ ok: true, peers });

      socket.to(rid).emit("video:user-joined", { uid, name, peerId });
    }
  );

  /**
   * Explicit "video:leave" from client.
   */
  socket.on("video:leave", (payload: { roomId: string; uid: string }) => {
    const rid = normRoomId(payload?.roomId);
    const uid = String(payload?.uid || "").trim();
    if (!rid || !uid) return;

    const map = rooms.get(rid);
    if (!map) return;

    map.delete(uid);
    if (map.size === 0) rooms.delete(rid);

    socket.to(rid).emit("video:user-left", { uid });
    socket.leave(rid);
  });

  /**
   * Cleanup when socket disconnects.
   */
  socket.on("disconnect", () => {
    const rid = socket.data?.rid as string | undefined;
    const uid = socket.data?.uid as string | undefined;
    if (!rid || !uid) return;

    const map = rooms.get(rid);
    if (!map) return;

    map.delete(uid);
    if (map.size === 0) rooms.delete(rid);

    socket.to(rid).emit("video:user-left", { uid });
  });
});

server.listen(PORT, () => {
  console.log(`[video-server] listening on :${PORT}`);
  console.log(`[video-server] allowed origins: ${allowedOrigins.join(", ")}`);
});
