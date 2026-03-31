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
                phraseCount: 0,
                turn: null
            };
        }

        // 입장 시 관전자로 우선 등록
        rooms[roomCode].spectators.push({ id: socket.id, name: userName });
        
        // [중요] 입장 즉시 모든 유저에게 최신 명단 전송 (명단 누락 버그 방지)
        updateRoomInfo(roomCode);
        io.to(roomCode).emit('systemMsg', `${userName}님이 입장하셨습니다.`);
    });

    // 2. 역할 변경 (플레이어 <-> 관전자)
    socket.on('changeRole', (role) => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (room.gameState !== 'LOBBY') return; // 게임 중엔 역할 변경 불가

        room.players = room.players.filter(p => p.id !== socket.id);
        room.spectators = room.spectators.filter(s => s.id !== socket.id);

        if (role === 'player') {
            if (room.players.length < 2) {
                room.players.push({ 
                    id: socket.id, 
                    name: userName, 
                    isReady: false, 
                    units: [], 
                    placed: false 
                });
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

    // 4. 게임 시작 버튼 (방장/플레이어가 시작 신호 보냄)
    socket.on('startGame', () => {
        const room = rooms[currentRoom];
        if (!room) return;
        
        // 조건: 2명 접속 및 전원 준비 완료
        if (room.players.length === 2 && room.players.every(p => p.isReady)) {
            room.gameState = 'PLACING';
            io.to(currentRoom).emit('startPlacing'); // 모든 클라이언트에 배치 시작 명령
            updateRoomInfo(currentRoom);
        } else {
            socket.emit('systemMsg', '모든 플레이어가 준비되어야 시작할 수 있습니다.');
        }
    });

    // 5. 배치 및 전술 기동 확정 로직 (유닛 데이터 처리)
    socket.on('finishPlacing', (units) => {
        const room = rooms[currentRoom];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        
        if (player) {
            player.units = units; // 클라이언트가 보낸 테트리스 유닛 데이터 저장
            player.placed = true;
        }

        // 두 명 다 확정(배치/기동)을 마쳤을 때
        if (room.players.length === 2 && room.players.every(p => p.placed)) {
            const prevState = room.gameState;
            room.gameState = 'PLAYING';
            room.players.forEach(p => p.placed = false); // 다음 5턴 후 기동을 위해 리셋

            if (prevState === 'PLACING') {
                // 최초 시작 시에만 랜덤 선공 결정
                const turnIndex = Math.floor(Math.random() * 2);
                room.turn = room.players[turnIndex].id;
                io.to(currentRoom).emit('gameStart', { turn: room.turn });
                io.to(currentRoom).emit('systemMsg', "전투 시작! 선공을 확인하세요.");
            } else {
                // 전술 기동(MOVING) 단계에서 복귀한 경우 (기존 턴 유지)
                io.to(currentRoom).emit('gameStart', { turn: room.turn });
                io.to(currentRoom).emit('systemMsg', "전술 기동 완료! 전투를 재개합니다.");
            }
            updateRoomInfo(currentRoom);
        } else {
            socket.emit('systemMsg', "상대방의 작전 완료를 기다리는 중입니다...");
        }
    });

    // 6. 공격 로직 (핵심 엔진)
    socket.on('attack', (index) => {
        const room = rooms[currentRoom];
        if (!room || room.gameState !== 'PLAYING' || room.turn !== socket.id) return;

        const opponent = room.players.find(p => p.id !== socket.id);
        let hitResult = false;

        // 상대방의 모든 유닛 덩어리를 뒤져서 타격 판정
        opponent.units.forEach(unit => {
            if (unit.cells.includes(index)) {
                if (!unit.hitCells) unit.hitCells = [];
                if (!unit.hitCells.includes(index)) {
                    unit.hitCells.push(index);
                    unit.isHit = true; // 타격된 유닛은 '고정' 상태로 변경
                }
                hitResult = true;
            }
        });

        if (hitResult) {
            // 적중 시 턴 유지
            io.to(currentRoom).emit('attackResult', { attacker: socket.id, index, hit: true });
            
            // 승리 판정: 모든 유닛의 모든 셀이 파괴되었는가?
            const allDestroyed = opponent.units.every(u => u.cells.length === (u.hitCells ? u.hitCells.length : 0));
            if (allDestroyed) {
                room.gameState = 'ENDED';
                io.to(currentRoom).emit('gameOver', { winner: userName });
            }
        } else {
            // 불발 시 턴 교체 및 프레이즈 카운트 증가
            room.turn = opponent.id;
            room.phraseCount++;
            io.to(currentRoom).emit('attackResult', { attacker: socket.id, index, hit: false, nextTurn: room.turn });

            // 5프레이즈(실패 5회) 도달 시 전술 기동 단계로 전환
            if (room.phraseCount > 0 && room.phraseCount % 5 === 0) {
                room.gameState = 'MOVING';
                io.to(currentRoom).emit('startMoving'); // 클라이언트에 이동 모드 명령
                io.to(currentRoom).emit('systemMsg', "⚠️ 5프레이즈 도달! 피격되지 않은 유닛을 재배치하세요.");
            }
        }
    });

    // 7. 다시하기 로직
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

    // 채팅 기능
    socket.on('sendChat', (msg) => {
        if (currentRoom) io.to(currentRoom).emit('receiveChat', { name: userName, msg });
    });

    // 연결 종료 처리
    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            rooms[currentRoom].players = rooms[currentRoom].players.filter(p => p.id !== socket.id);
            rooms[currentRoom].spectators = rooms[currentRoom].spectators.filter(s => s.id !== socket.id);
            updateRoomInfo(currentRoom);
        }
    });

    // 핵심: 방 정보 통합 전송 함수
    function updateRoomInfo(roomCode) {
        if (rooms[roomCode]) {
            io.to(roomCode).emit('roomData', rooms[roomCode]);
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tactical Engine Active on port ${PORT}`));
