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
                room.players.push({ id: socket.id, name: userName, isReady: false, blocks: [], foundBlocks: [], placed: false });
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

    // 5. 배치 완료 로직
    socket.on('finishPlacing', (blocks) => {
        const room = rooms[currentRoom];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.blocks = blocks; 
            player.placed = true;
        }

        if (room.players.length === 2 && room.players.every(p => p.placed)) {
            room.gameState = 'PLAYING';
            const turnIndex = Math.floor(Math.random() * 2);
            room.turn = room.players[turnIndex].id;
            
            io.to(currentRoom).emit('gameStart', {
                turn: room.turn,
                turnName: room.players[turnIndex].name
            });
            io.to(currentRoom).emit('systemMsg', `전투 시작! 선공은 ${room.players[turnIndex].name}님입니다.`);
        } else {
            io.to(currentRoom).emit('systemMsg', `${userName}님이 배치를 마쳤습니다.`);
        }
    });

    // 6. 공격 로직
    socket.on('attack', (index) => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'PLAYING' || room.turn !== socket.id) return;

        const opponent = room.players.find(p => p.id !== socket.id);
        const hit = opponent.blocks.includes(index);

        if (hit) {
            if (!opponent.foundBlocks.includes(index)) {
                opponent.foundBlocks.push(index);
            }
            io.to(currentRoom).emit('attackResult', { attacker: socket.id, index, hit: true });
            
            if (opponent.foundBlocks.length === opponent.blocks.length) {
                room.gameState = 'ENDED';
                io.to(currentRoom).emit('gameOver', { winner: userName });
            }
        } else {
            room.turn = opponent.id;
            room.phraseCount++;
            io.to(currentRoom).emit('attackResult', { attacker: socket.id, index, hit: false, nextTurn: room.turn });

            // 5프레이즈 도달 시 이동 및 내 화면 갱신 데이터 전송
            if (room.phraseCount > 0 && room.phraseCount % 5 === 0) {
                moveUnfoundBlocks(room);
                io.to(currentRoom).emit('systemMsg', "⚠️ 5프레이즈 도달! 발견되지 않은 블록들이 이동했습니다!");
                
                // [추가] 플레이어 각자에게 이동된 "자신의" 블록 위치를 알려줌
                room.players.forEach(player => {
                    io.to(player.id).emit('updateMyBlocks', player.blocks);
                });
            }
        }
    });

    // 7. [신규] 다시하기 (방 초기화) 로직
    socket.on('requestRematch', () => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'ENDED') return;

        // 방 데이터 초기화
        room.gameState = 'LOBBY';
        room.phraseCount = 0;
        room.players.forEach(p => {
            p.isReady = false;
            p.blocks = [];
            p.foundBlocks = [];
            p.placed = false;
        });

        io.to(currentRoom).emit('rematchStarted'); // 클라이언트에 초기화 신호 전송
        updateRoomInfo(currentRoom);
        io.to(currentRoom).emit('systemMsg', "방이 초기화되었습니다. 다시 준비해주세요!");
    });

    // 블록 이동 함수
    function moveUnfoundBlocks(room) {
        room.players.forEach(player => {
            player.blocks = player.blocks.map(blockIdx => {
                if (player.foundBlocks.includes(blockIdx)) return blockIdx;
                const directions = [-1, 1, -20, 20];
                const randomDir = directions[Math.floor(Math.random() * directions.length)];
                const nextIdx = blockIdx + randomDir;
                if (nextIdx >= 0 && nextIdx < 200) return nextIdx;
                return blockIdx;
            });
        });
    }

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
