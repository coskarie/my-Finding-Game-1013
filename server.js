const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 방 데이터 저장소
const rooms = {};

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
    let currentRoom = null;
    let userName = "";

    // 방 입장
    socket.on('joinRoom', (data) => {
        const { roomCode, name } = data;
        currentRoom = roomCode;
        userName = name;

        socket.join(roomCode);

        // 방 데이터 초기화
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                players: [], // 최대 2명
                spectators: [], // 최대 10명
                gameState: 'LOBBY' // LOBBY, PLACING, PLAYING
            };
        }

        // 기본적으로 관전자로 입장
        if (rooms[roomCode].spectators.length < 10) {
            rooms[roomCode].spectators.push({ id: socket.id, name: userName });
        }

        updateRoomInfo(roomCode);
        io.to(roomCode).emit('systemMsg', `${userName}님이 입장하셨습니다.`);
    });

    // 역할 변경 (플레이어로 올라가기 / 관전자로 내려오기)
    socket.on('changeRole', (role) => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (room.gameState !== 'LOBBY') return; // 게임 중엔 이동 불가

        // 기존 목록에서 제거
        room.players = room.players.filter(p => p.id !== socket.id);
        room.spectators = room.spectators.filter(s => s.id !== socket.id);

        if (role === 'player') {
            if (room.players.length < 2) {
                room.players.push({ id: socket.id, name: userName });
            } else {
                socket.emit('systemMsg', '플레이어 자리가 꽉 찼습니다.');
                room.spectators.push({ id: socket.id, name: userName });
            }
        } else {
            room.spectators.push({ id: socket.id, name: userName });
        }

        updateRoomInfo(currentRoom);
    });

    // 채팅 메시지
    socket.on('sendChat', (msg) => {
        if (currentRoom) {
            io.to(currentRoom).emit('receiveChat', { name: userName, msg });
        }
    });

    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            rooms[currentRoom].players = rooms[currentRoom].players.filter(p => p.id !== socket.id);
            rooms[currentRoom].spectators = rooms[currentRoom].spectators.filter(s => s.id !== socket.id);
            updateRoomInfo(currentRoom);
        }
    });

    function updateRoomInfo(roomCode) {
        io.to(roomCode).emit('roomData', rooms[roomCode]);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));