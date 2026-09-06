const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const server = new WebSocket.Server({ port: PORT });
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

server.on("connection", socket => {
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

console.log(`Earpiece server running on port ${PORT}`);
