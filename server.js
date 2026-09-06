const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    let filePath;

    try {
        filePath = decodeURIComponent(req.url.split("?")[0]);
    } catch {
        res.writeHead(400);
        res.end("Bad Request");
        return;
    }

    if (filePath === "/") {
        filePath = "/index.html";
    }

    const fullPath = path.join(__dirname, filePath);

    if (!fullPath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    const ext = path.extname(fullPath);

    const types = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon"
    };

    fs.readFile(fullPath, (err, data) => {
        if (err) {
            res.writeHead(404, {
                "Content-Type": "text/plain; charset=utf-8"
            });
            res.end("Not Found");
            return;
        }

        res.writeHead(200, {
            "Content-Type": types[ext] || "application/octet-stream",
            "Cache-Control": "no-cache"
        });

        res.end(data);
    });
});

const wss = new WebSocket.Server({
    server,
    perMessageDeflate: false
});

const rooms = new Map();

function send(socket, data) {
    if (socket.readyState === WebSocket.OPEN) {
        try {
            socket.send(JSON.stringify(data));
        } catch {}
    }
}

function removeUser(socket) {
    if (!socket.room || !socket.userId) {
        return;
    }

    const roomName = socket.room;
    const userId = socket.userId;
    const room = rooms.get(roomName);

    socket.room = null;
    socket.userId = null;

    if (!room) {
        return;
    }

    if (room.get(userId) !== socket) {
        return;
    }

    room.delete(userId);

    for (const user of room.values()) {
        send(user, {
            type: "user-left",
            userId
        });

        send(user, {
            type: "room-count",
            count: room.size
        });
    }

    if (room.size === 0) {
        rooms.delete(roomName);
    }
}

wss.on("connection", socket => {
    socket.room = null;
    socket.userId = null;
    socket.isAlive = true;

    socket.on("pong", () => {
        socket.isAlive = true;
    });

    socket.on("message", data => {
        let message;

        try {
            message = JSON.parse(data.toString());
        } catch {
            return;
        }

        if (message.type === "join-room") {
            const roomName = String(message.room || "")
                .trim()
                .toUpperCase();

            const userId = String(message.userId || "").trim();

            if (!roomName || !userId) {
                return;
            }

            removeUser(socket);

            let room = rooms.get(roomName);

            if (!room) {
                room = new Map();
                rooms.set(roomName, room);
            }

            const existingUsers = [...room.keys()];

            socket.room = roomName;
            socket.userId = userId;

            room.set(userId, socket);

            send(socket, {
                type: "room-users",
                users: existingUsers
            });

            for (const [id, user] of room) {
                if (id === userId) {
                    continue;
                }

                send(user, {
                    type: "user-joined",
                    userId
                });

                send(user, {
                    type: "room-count",
                    count: room.size
                });
            }

            send(socket, {
                type: "room-count",
                count: room.size
            });

            return;
        }

        if (message.type === "leave-room") {
            removeUser(socket);
            return;
        }

        if (
            message.type === "offer" ||
            message.type === "answer" ||
            message.type === "ice-candidate"
        ) {
            if (!socket.room || !socket.userId) {
                return;
            }

            const room = rooms.get(socket.room);

            if (!room) {
                return;
            }

            const targetId = String(message.target || "");
            const target = room.get(targetId);

            if (!target) {
                return;
            }

            send(target, message);
        }
    });

    socket.on("close", () => {
        removeUser(socket);
    });

    socket.on("error", () => {
        removeUser(socket);
    });
});

const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
        if (socket.isAlive === false) {
            removeUser(socket);

            try {
                socket.terminate();
            } catch {}

            continue;
        }

        socket.isAlive = false;

        try {
            socket.ping();
        } catch {}
    }
}, 25000);

wss.on("close", () => {
    clearInterval(heartbeat);
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Earpiece server running on port ${PORT}`);
});
