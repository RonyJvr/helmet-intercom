const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    let filePath = req.url === "/" ? "/index.html" : req.url;
    filePath = path.join(__dirname, filePath);

    const ext = path.extname(filePath);

    const types = {
        ".html": "text/html",
        ".css": "text/css",
        ".js": "application/javascript",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon"
    };

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
        }

        res.writeHead(200, {
            "Content-Type": types[ext] || "application/octet-stream"
        });

        res.end(data);
    });
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

function send(socket, data) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(data));
    }
}

function removeUser(socket) {
    if (!socket.room || !socket.userId) return;

    const room = rooms.get(socket.room);
    if (!room) return;

    room.delete(socket.userId);

    for (const user of room.values()) {
        send(user, {
            type: "user-left",
            userId: socket.userId
        });

        send(user, {
            type: "room-count",
            count: room.size
        });
    }

    if (room.size === 0) {
        rooms.delete(socket.room);
    }
}

wss.on("connection", socket => {
    socket.room = null;
    socket.userId = null;

    socket.on("message", data => {
        let message;

        try {
            message = JSON.parse(data.toString());
        } catch {
            return;
        }

        if (message.type === "join-room") {
            const roomName = String(message.room || "").trim().toUpperCase();
            const userId = String(message.userId || "").trim();

            if (!roomName || !userId) return;

            removeUser(socket);

            const room = rooms.get(roomName) || new Map();
            rooms.set(roomName, room);

            const existingUsers = [...room.keys()];

            socket.room = roomName;
            socket.userId = userId;

            room.set(userId, socket);

            send(socket, {
                type: "room-users",
                users: existingUsers
            });

            for (const [id, user] of room) {
                if (id === userId) continue;

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
            socket.room = null;
            socket.userId = null;
            return;
        }

        if (
            message.type === "offer" ||
            message.type === "answer" ||
            message.type === "ice-candidate"
        ) {
            const room = rooms.get(socket.room);
            if (!room) return;

            const target = room.get(message.target);
            if (!target) return;

            send(target, message);
        }
    });

    socket.on("close", () => removeUser(socket));
    socket.on("error", () => removeUser(socket));
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Helmet Intercom running on port ${PORT}`);
});