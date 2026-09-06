const express = require('express');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}
const LOCAL_IP = getLocalIP();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

function broadcastMemberList(code) {
  if (!rooms[code]) return;
  const memberNames = Object.values(rooms[code].members);
  io.to(code).emit('member-list', { members: memberNames, hostId: rooms[code].hostId });
}

function canControlSong(room, socketId) {
  const isHost = socketId === room.hostId;
  const everyoneAllowed = room.songMode === 'everyone';
  return isHost || everyoneAllowed;
}

io.on('connection', (socket) => {
  console.log('Device connected:', socket.id);
  socket.emit('server-info', { ip: LOCAL_IP });

  socket.on('sync-ping', (clientSentTime) => {
    socket.emit('sync-pong', { serverTime: Date.now(), clientSentTime });
  });

  socket.on('create-room', ({ partyName, userName, songMode }) => {
    const code = generateRoomCode();
    const safeSongMode = songMode === 'everyone' ? 'everyone' : 'host';
    rooms[code] = {
      name: partyName || 'Untitled Party',
      hostId: socket.id,
      members: { [socket.id]: userName || 'Host' },
      selectedSong: null,
      songMode: safeSongMode,
      partyInProgress: false,
      partyStarted: false,
      partyStartTime: null,
      isPaused: false,
      pausedElapsed: null,
      queue: [],
      chatHistory: []
    };
    socket.join(code);
    socket.data.room = code;
    socket.data.name = userName || 'Host';
    socket.emit('room-created', {
      code,
      partyName: rooms[code].name,
      songMode: rooms[code].songMode
    });
    broadcastMemberList(code);
  });

  socket.on('join-room', ({ code, userName }) => {
    code = (code || '').toUpperCase().trim();
    if (!rooms[code]) {
      socket.emit('room-joined', { success: false });
      return;
    }
    socket.join(code);
    socket.data.room = code;
    socket.data.name = userName || 'Guest';
    rooms[code].members[socket.id] = userName || 'Guest';

    const room = rooms[code];

    socket.emit('room-joined', {
      success: true,
      code,
      partyName: room.name,
      songMode: room.songMode
    });
    socket.to(code).emit('member-joined', { name: userName || 'Guest' });
    broadcastMemberList(code);

    if (room.selectedSong) {
      socket.emit('song-selected', { song: room.selectedSong });
    }

    if (room.partyStarted) {
      if (room.isPaused) {
        socket.emit('pause', { elapsed: room.pausedElapsed });
      } else if (room.partyStartTime !== null) {
        socket.emit('play', { startTime: room.partyStartTime });
      }
      socket.emit('queue-updated', { queue: room.queue });
    }

    socket.emit('chat-history', room.chatHistory);
  });

  socket.on('select-song', (songFile) => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.partyStarted) return; // once started, use add-to-queue instead
    if (!canControlSong(room, socket.id)) return;
    room.selectedSong = songFile;
    io.to(code).emit('song-selected', { song: songFile });
  });

  socket.on('add-to-queue', (songFile) => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (!room.partyStarted) return; // only allowed once the party has started
    if (!canControlSong(room, socket.id)) return;
    if (!songFile) return;
    room.queue.push(songFile);
    io.to(code).emit('queue-updated', { queue: room.queue });
  });

  socket.on('start-party', () => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (socket.id !== room.hostId) return;
    if (room.partyInProgress) return;
    if (!room.selectedSong) {
      socket.emit('start-error', { message: 'Pick a song first!' });
      return;
    }
    room.partyInProgress = true;
    room.partyStarted = true;
    room.isPaused = false;
    room.pausedElapsed = null;
    const startTime = Date.now() + 3000;
    room.partyStartTime = startTime;
    io.to(code).emit('play', { startTime });
    setTimeout(() => { if (rooms[code]) rooms[code].partyInProgress = false; }, 4000);
  });

  socket.on('pause-party', () => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (socket.id !== room.hostId) return;
    if (!room.partyStarted || room.isPaused || room.partyStartTime === null) return;
    const elapsed = Date.now() - room.partyStartTime;
    room.isPaused = true;
    room.pausedElapsed = elapsed;
    io.to(code).emit('pause', { elapsed });
  });

  socket.on('resume-party', () => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (socket.id !== room.hostId) return;
    if (!room.isPaused) return;
    const newStartTime = Date.now() - (room.pausedElapsed || 0);
    room.partyStartTime = newStartTime;
    room.isPaused = false;
    room.pausedElapsed = null;
    io.to(code).emit('play', { startTime: newStartTime });
  });

  socket.on('song-ended', () => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (socket.id !== room.hostId) return; // only trust the host's playback clock
    if (room.queue.length === 0) {
      room.selectedSong = null;
      room.partyStartTime = null;
      room.isPaused = false;
      room.pausedElapsed = null;
      io.to(code).emit('queue-empty');
      return;
    }
    const nextSong = room.queue.shift();
    room.selectedSong = nextSong;
    room.isPaused = false;
    room.pausedElapsed = null;
    const startTime = Date.now() + 3000; // buffer time for every client to fetch+decode the next track
    room.partyStartTime = startTime;
    io.to(code).emit('song-selected', { song: nextSong });
    io.to(code).emit('play', { startTime });
    io.to(code).emit('queue-updated', { queue: room.queue });
  });

  socket.on('chat-message', ({ type, content }) => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const msg = { name: socket.data.name || 'Someone', type, content, time: Date.now() };
    rooms[code].chatHistory.push(msg);
    if (rooms[code].chatHistory.length > 100) rooms[code].chatHistory.shift();
    io.to(code).emit('chat-message', msg);
  });

  socket.on('disconnect', (reason) => {
    const code = socket.data.room;
    if (code && rooms[code]) {
      const name = rooms[code].members[socket.id];
      delete rooms[code].members[socket.id];
      io.to(code).emit('member-left', { name });
      broadcastMemberList(code);
      if (Object.keys(rooms[code].members).length === 0) {
        delete rooms[code];
      }
    }
  });
});

server.listen(3000, () => {
  console.log('Server running on port 3000 — LAN IP:', LOCAL_IP);
});