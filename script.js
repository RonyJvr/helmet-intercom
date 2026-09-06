const SIGNALING_SERVER = "wss://helmet-intercom.onrender.com";

const ICE_SERVERS = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
    ]
};

const roomButton = document.getElementById("roomButton");
const roomModal = document.getElementById("roomModal");
const closeRoomModal = document.getElementById("closeRoomModal");
const roomInput = document.getElementById("roomInput");
const joinRoomButton = document.getElementById("joinRoomButton");
const newRoomButton = document.getElementById("newRoomButton");
const copyRoomButton = document.getElementById("copyRoomButton");

const roomLabel = document.getElementById("roomLabel");
const roomCodeDisplay = document.getElementById("roomCodeDisplay");
const peopleCount = document.getElementById("peopleCount");

const connectionStatus = document.getElementById("connectionStatus");
const roomStatus = document.getElementById("roomStatus");
const statusDot = document.getElementById("statusDot");

const muteButton = document.getElementById("muteButton");
const muteText = document.getElementById("muteText");
const micIcon = document.getElementById("micIcon");

const amplificationSlider = document.getElementById("amplificationSlider");
const amplificationValue = document.getElementById("amplificationValue");

const volumeSlider = document.getElementById("volumeSlider");
const volumeValue = document.getElementById("volumeValue");

let signalingSocket = null;
let localStream = null;
let roomCode = getRoomFromUrl();
let userId = crypto.randomUUID();

const peers = new Map();
const remoteSources = new Map();
const remoteStreams = new Map();
const pendingCandidates = new Map();

let isMuted = false;
let reconnectTimer = null;

let audioContext = null;
let remoteGainNode = null;
let remoteVolumeNode = null;

function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let result = "";

    for (let i = 0; i < 6; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }

    return result;
}

function getRoomFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get("room") || generateRoomCode();
}

function updateRoomUI() {
    roomLabel.textContent = roomCode;
    roomCodeDisplay.textContent = roomCode;
    roomInput.value = roomCode;
}

function updateUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomCode);
    window.history.replaceState({}, "", url);
}

function setConnectionStatus(connected, text) {
    connectionStatus.textContent = text;

    if (connected) {
        statusDot.classList.add("connected");
        roomStatus.textContent = "Connected";
    } else {
        statusDot.classList.remove("connected");
        roomStatus.textContent = "Connecting";
    }
}

async function resumeAudio() {
    if (!audioContext) return;

    if (audioContext.state !== "running") {
        try {
            await audioContext.resume();
        } catch {}
    }
}

async function setupAudio() {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    remoteGainNode = audioContext.createGain();
    remoteVolumeNode = audioContext.createGain();

    remoteGainNode.gain.value = Number(amplificationSlider.value);
    remoteVolumeNode.gain.value = Number(volumeSlider.value) / 100;

    remoteGainNode.connect(remoteVolumeNode);
    remoteVolumeNode.connect(audioContext.destination);

    localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1
        },
        video: false
    });

    setMuted(false);
}

function createRemoteAudio(peerId, stream) {
    if (!audioContext || !remoteGainNode) return;

    remoteStreams.set(peerId, stream);

    const oldSource = remoteSources.get(peerId);

    if (oldSource) {
        try {
            oldSource.disconnect();
        } catch {}
    }

    const source = audioContext.createMediaStreamSource(stream);

    source.connect(remoteGainNode);

    remoteSources.set(peerId, source);

    for (const track of stream.getAudioTracks()) {
        track.onunmute = () => {
            resumeAudio();
        };

        track.onmute = () => {};

        track.onended = () => {
            resumeAudio();
        };
    }

    resumeAudio();
}

function removePeer(peerId) {
    const peer = peers.get(peerId);

    if (peer) {
        peer.ontrack = null;
        peer.onicecandidate = null;
        peer.onconnectionstatechange = null;
        peer.oniceconnectionstatechange = null;

        try {
            peer.close();
        } catch {}

        peers.delete(peerId);
    }

    const source = remoteSources.get(peerId);

    if (source) {
        try {
            source.disconnect();
        } catch {}

        remoteSources.delete(peerId);
    }

    remoteStreams.delete(peerId);
    pendingCandidates.delete(peerId);

    updatePeopleCount();
}

function updatePeopleCount(serverCount = null) {
    if (typeof serverCount === "number") {
        peopleCount.textContent = Math.max(1, serverCount);
        return;
    }

    peopleCount.textContent = Math.max(1, peers.size + 1);
}

function send(message) {
    if (
        signalingSocket &&
        signalingSocket.readyState === WebSocket.OPEN
    ) {
        signalingSocket.send(JSON.stringify(message));
    }
}

function createPeer(peerId, shouldOffer) {
    if (peers.has(peerId)) {
        return peers.get(peerId);
    }

    const peer = new RTCPeerConnection(ICE_SERVERS);

    peers.set(peerId, peer);
    pendingCandidates.set(peerId, []);

    if (localStream) {
        for (const track of localStream.getTracks()) {
            peer.addTrack(track, localStream);
        }
    }

    peer.ontrack = event => {
        const stream =
            event.streams && event.streams[0]
                ? event.streams[0]
                : new MediaStream([event.track]);

        createRemoteAudio(peerId, stream);
    };

    peer.onicecandidate = event => {
        if (!event.candidate) return;

        send({
            type: "ice-candidate",
            sender: userId,
            target: peerId,
            candidate: event.candidate
        });
    };

    peer.onconnectionstatechange = () => {
        const state = peer.connectionState;

        if (state === "failed") {
            try {
                peer.restartIce();
            } catch {}
        }

        if (state === "closed") {
            removePeer(peerId);
        }

        updatePeopleCount();
    };

    peer.oniceconnectionstatechange = () => {
        if (peer.iceConnectionState === "failed") {
            try {
                peer.restartIce();
            } catch {}
        }
    };

    if (shouldOffer) {
        createOffer(peerId, peer);
    }

    updatePeopleCount();

    return peer;
}

async function createOffer(peerId, peer) {
    try {
        const offer = await peer.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: false
        });

        await peer.setLocalDescription(offer);

        send({
            type: "offer",
            sender: userId,
            target: peerId,
            offer: peer.localDescription
        });
    } catch {}
}

async function flushCandidates(peerId, peer) {
    const candidates = pendingCandidates.get(peerId) || [];

    pendingCandidates.set(peerId, []);

    for (const candidate of candidates) {
        try {
            await peer.addIceCandidate(
                new RTCIceCandidate(candidate)
            );
        } catch {}
    }
}

async function handleOffer(message) {
    const peer = createPeer(message.sender, false);

    try {
        await peer.setRemoteDescription(
            new RTCSessionDescription(message.offer)
        );

        await flushCandidates(message.sender, peer);

        const answer = await peer.createAnswer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: false
        });

        await peer.setLocalDescription(answer);

        send({
            type: "answer",
            sender: userId,
            target: message.sender,
            answer: peer.localDescription
        });
    } catch {}
}

async function handleAnswer(message) {
    const peer = peers.get(message.sender);

    if (!peer) return;

    try {
        await peer.setRemoteDescription(
            new RTCSessionDescription(message.answer)
        );

        await flushCandidates(message.sender, peer);
    } catch {}
}

async function handleIceCandidate(message) {
    if (!message.candidate || !message.sender) return;

    const peer = peers.get(message.sender);

    if (!peer) return;

    if (!peer.remoteDescription) {
        const candidates =
            pendingCandidates.get(message.sender) || [];

        candidates.push(message.candidate);
        pendingCandidates.set(message.sender, candidates);

        return;
    }

    try {
        await peer.addIceCandidate(
            new RTCIceCandidate(message.candidate)
        );
    } catch {}
}

function connectSignaling() {
    clearTimeout(reconnectTimer);

    if (signalingSocket) {
        try {
            signalingSocket.close();
        } catch {}
    }

    signalingSocket = new WebSocket(SIGNALING_SERVER);

    signalingSocket.onopen = () => {
        setConnectionStatus(true, "Connected");

        send({
            type: "join-room",
            room: roomCode,
            userId
        });
    };

    signalingSocket.onmessage = async event => {
        let message;

        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }

        switch (message.type) {
            case "room-users":
                if (Array.isArray(message.users)) {
                    updatePeopleCount(message.users.length);

                    for (const id of message.users) {
                        if (id !== userId) {
                            createPeer(id, false);
                        }
                    }
                }
                break;

            case "user-joined":
                if (
                    message.userId &&
                    message.userId !== userId
                ) {
                    createPeer(message.userId, true);
                }
                break;

            case "user-left":
                if (message.userId) {
                    removePeer(message.userId);
                }
                break;

            case "offer":
                if (message.target === userId) {
                    await handleOffer(message);
                }
                break;

            case "answer":
                if (message.target === userId) {
                    await handleAnswer(message);
                }
                break;

            case "ice-candidate":
                if (message.target === userId) {
                    await handleIceCandidate(message);
                }
                break;

            case "room-count":
                if (typeof message.count === "number") {
                    updatePeopleCount(message.count);
                }
                break;
        }
    };

    signalingSocket.onclose = () => {
        setConnectionStatus(false, "Reconnecting...");

        reconnectTimer = setTimeout(() => {
            connectSignaling();
        }, 2000);
    };

    signalingSocket.onerror = () => {
        setConnectionStatus(false, "Connection error");
    };
}

async function switchRoom(newRoom) {
    newRoom = newRoom.trim().toUpperCase();

    if (!newRoom) return;

    send({
        type: "leave-room",
        room: roomCode,
        userId
    });

    for (const peerId of [...peers.keys()]) {
        removePeer(peerId);
    }

    if (signalingSocket) {
        try {
            signalingSocket.close();
        } catch {}
    }

    roomCode = newRoom;

    updateRoomUI();
    updateUrl();

    roomModal.classList.add("hidden");

    connectSignaling();
}

function setMuted(value) {
    isMuted = value;

    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = !isMuted;
        });
    }

    if (isMuted) {
        muteButton.classList.add("muted");
        muteText.textContent = "Unmute Microphone";

        micIcon.innerHTML = `
            <rect x="8" y="3" width="8" height="12" rx="4"/>
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7"/>
            <path d="m4 4 16 16"/>
        `;
    } else {
        muteButton.classList.remove("muted");
        muteText.textContent = "Mute Microphone";

        micIcon.innerHTML = `
            <rect x="8" y="3" width="8" height="12" rx="4"/>
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7"/>
        `;
    }
}

amplificationSlider.addEventListener("input", () => {
    const value = Number(amplificationSlider.value);

    amplificationValue.textContent = `${value.toFixed(1)}×`;

    if (remoteGainNode && audioContext) {
        remoteGainNode.gain.setTargetAtTime(
            value,
            audioContext.currentTime,
            0.015
        );
    }
});

volumeSlider.addEventListener("input", () => {
    const value = Number(volumeSlider.value);

    volumeValue.textContent = `${Math.round(value)}%`;

    if (remoteVolumeNode && audioContext) {
        remoteVolumeNode.gain.setTargetAtTime(
            value / 100,
            audioContext.currentTime,
            0.015
        );
    }
});

muteButton.addEventListener("click", async () => {
    await resumeAudio();
    setMuted(!isMuted);
});

document.addEventListener(
    "click",
    () => {
        resumeAudio();
    },
    { once: true }
);

roomButton.addEventListener("click", () => {
    roomInput.value = roomCode;
    roomModal.classList.remove("hidden");
    roomInput.focus();
    roomInput.select();
});

closeRoomModal.addEventListener("click", () => {
    roomModal.classList.add("hidden");
});

roomModal.addEventListener("click", event => {
    if (event.target === roomModal) {
        roomModal.classList.add("hidden");
    }
});

joinRoomButton.addEventListener("click", () => {
    switchRoom(roomInput.value);
});

roomInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        switchRoom(roomInput.value);
    }
});

newRoomButton.addEventListener("click", () => {
    roomInput.value = generateRoomCode();
    switchRoom(roomInput.value);
});

copyRoomButton.addEventListener("click", async () => {
    const shareUrl =
        `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomCode)}`;

    try {
        await navigator.clipboard.writeText(shareUrl);

        const original = copyRoomButton.innerHTML;

        copyRoomButton.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m5 12 4 4L19 6"/>
            </svg>
            Copied
        `;

        setTimeout(() => {
            copyRoomButton.innerHTML = original;
        }, 1500);
    } catch {}
});

window.addEventListener("beforeunload", () => {
    send({
        type: "leave-room",
        room: roomCode,
        userId
    });

    if (signalingSocket) {
        try {
            signalingSocket.close();
        } catch {}
    }
});

async function start() {
    updateRoomUI();
    updateUrl();

    try {
        await setupAudio();
        connectSignaling();
    } catch {
        setConnectionStatus(false, "Microphone unavailable");
        roomStatus.textContent = "Allow microphone access";
    }
}

start();
