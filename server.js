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

    // 1. 방 입장
    socket.on('joinRoom', (data) => {
        const { roomCode, name } = data;
        currentRoom = roomCode;
        userName = name;
        socket.join(roomCode);

        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                players: [], 
                spectators: [], 
                gameState: 'LOBBY',
                phraseCount: 0 
            };
        }

        rooms[roomCode].spectators.push({ id: socket.id, name: userName });
        updateRoomInfo(roomCode);
        io.to(roomCode).emit('systemMsg', `${userName}님이 입장하셨습니다.`);
    });

    // 2. 역할 변경
    socket.on('changeRole', (role) => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (room.gameState !== 'LOBBY') return; 

        room.players = room.players.filter(p => p.id !== socket.id);
        room.spectators = room.spectators.filter(s => s.id !== socket.id);

        if (role === 'player') {
            if (room.players.length < 2) {
                // units: 유닛 덩어리 정보를 담는 배열
                room.players.push({ id: socket.id, name: userName, isReady: false, units: [], placed: false });
            } else {
                socket.emit('systemMsg', '플레이어 자리가 꽉 찼습니다.');
                room.spectators.push({ id: socket.id, name: userName });
            }
        } else {
            room.spectators.push({ id: socket.id, name: userName });
        }
        updateRoomInfo(currentRoom);
    });

    // 3. 준비 완료 버튼 토글 (V 표시)
    socket.on('toggleReady', () => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'LOBBY') return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.isReady = !player.isReady;
            updateRoomInfo(currentRoom);
        }
    });

    // 4. 게임 시작 버튼 (둘 다 V일 때만)
    socket.on('startGame', () => {
        const room = rooms[currentRoom];
        if (!room) return;
        
        if (room.players.length === 2 && room.players.every(p => p.isReady)) {
            room.gameState = 'PLACING';
            io.to(currentRoom).emit('startPlacing');
            updateRoomInfo(currentRoom);
        }
    });

    // 5. 배치 및 전술 기동 확정 로직 (유닛 데이터 처리)
    socket.on('finishPlacing', (units) => {
        const room = rooms[currentRoom];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.units = units; // 유닛(타입, 좌표들, 피격여부) 객체 배열 저장
            player.placed = true;
        }

        // 두 명 다 배치를 마쳤을 때
        if (room.players.length === 2 && room.players.every(p => p.placed)) {
            const prevState = room.gameState;
            room.gameState = 'PLAYING';
            room.players.forEach(p => p.placed = false); // 다음 기동을 위해 리셋

            if (prevState === 'PLACING') {
                const turnIndex = Math.floor(Math.random() * 2);
                room.turn = room.players[turnIndex].id;
                io.to(currentRoom).emit('gameStart', { turn: room.turn });
                io.to(currentRoom).emit('systemMsg', "전투 시작!");
            } else {
                // 기동 단계(MOVING)에서 돌아온 경우
                io.to(currentRoom).emit('gameStart', { turn: room.turn });
                io.to(currentRoom).emit('systemMsg', "전술 기동 완료! 전투를 재개합니다.");
            }
        } else {
            socket.emit('systemMsg', "상대방의 작전 완료를 기다리는 중입니다...");
        }
    });

    // 6. 공격 로직 (유닛 판정 추가)
    socket.on('attack', (index) => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'PLAYING' || room.turn !== socket.id) return;

        const opponent = room.players.find(p => p.id !== socket.id);
        let hitUnit = null;

        // 상대방 유닛들 중 해당 좌표를 포함하는 유닛 탐색
        opponent.units.forEach(unit => {
            if (unit.cells.includes(index)) {
                if (!unit.hitCells) unit.hitCells = [];
                if (!unit.hitCells.includes(index)) {
                    unit.hitCells.push(index);
                    unit.isHit = true; // 유닛 일부가 맞으면 해당 유닛은 '이동 불가' 상태가 됨
                }
                hitUnit = unit;
            }
        });

        if (hitUnit) {
            io.to(currentRoom).emit('attackResult', { attacker: socket.id, index, hit: true });
            
            // 모든 유닛의 모든 칸이 파괴되었는지 검사
            const allDestroyed = opponent.units.every(u => u.cells.length === (u.hitCells ? u.hitCells.length : 0));
            if (allDestroyed) {
                room.gameState = 'ENDED';
                io.to(currentRoom).emit('gameOver', { winner: userName });
            }
        } else {
            room.turn = opponent.id;
            room.phraseCount++;
            io.to(currentRoom).emit('attackResult', { attacker: socket.id, index, hit: false, nextTurn: room.turn });

            // 5프레이즈 도달 시 전술 기동 단계로 전환
            if (room.phraseCount > 0 && room.phraseCount % 5 === 0) {
                room.gameState = 'MOVING';
                io.to(currentRoom).emit('startMoving');
                io.to(currentRoom).emit('systemMsg', "⚠️ 5프레이즈 도달! 전술 기동 단계입니다. 피격되지 않은 유닛을 재배치하세요.");
            }
        }
    });

    // 7. 다시하기 로직 (원본 유지)
    socket.on('requestRematch', () => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'ENDED') return;

        room.gameState = 'LOBBY';
        room.phraseCount = 0;
        room.turn = null;
        room.players.forEach(p => {
            p.isReady = false;
            p.units = [];
            p.placed = false;
        });

        io.to(currentRoom).emit('rematchStarted');
        updateRoomInfo(currentRoom);
        io.to(currentRoom).emit('systemMsg', "방이 초기화되었습니다. 다시 준비해주세요!");
    });

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
server.listen(PORT, () => console.log(`Tactical Server running on port ${PORT}`));
