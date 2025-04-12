const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingInterval: 10000,
  pingTimeout: 5000,
  transports: ['websocket', 'polling']
});
const path = require('path');
const fs = require('fs');

// Enhanced database with better error handling
const dbFile = path.join(__dirname, 'db.json');
let db = {
  callRecords: [],
  offlineMessages: {},
  rooms: {},
  stats: {
    totalCalls: 0,
    failedCalls: 0
  }
};

// Load database with error handling
function loadDB() {
  try {
    if (fs.existsSync(dbFile)) {
      const data = fs.readFileSync(dbFile, 'utf8');
      db = JSON.parse(data);
      console.log('Database loaded successfully');
    }
  } catch (err) {
    console.error('Error loading database:', err);
    // Initialize fresh database if loading fails
    db = {
      callRecords: [],
      offlineMessages: {},
      rooms: {},
      stats: {
        totalCalls: 0,
        failedCalls: 0
      }
    };
  }
}

// Save database with error handling and retries
function saveDB() {
  let attempts = 0;
  const maxAttempts = 3;
  
  function attemptSave() {
    try {
      fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
      console.log('Database saved successfully');
    } catch (err) {
      attempts++;
      console.error(`Error saving database (attempt ${attempts}):`, err);
      if (attempts < maxAttempts) {
        setTimeout(attemptSave, 1000);
      }
    }
  }
  
  attemptSave();
}

// Initial database load
loadDB();

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API endpoints with error handling
app.get('/api/call-history', (req, res) => {
  try {
    res.json({
      success: true,
      data: db.callRecords.slice(-20).reverse(),
      stats: db.stats
    });
  } catch (err) {
    console.error('Error getting call history:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/offline-messages/:room', (req, res) => {
  try {
    const messages = db.offlineMessages[req.params.room] || [];
    res.json({ success: true, data: messages });
  } catch (err) {
    console.error('Error getting offline messages:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Enhanced WebSocket signaling with better error handling
io.on('connection', socket => {
  console.log(`New connection: ${socket.id}`);
  db.stats.totalConnections = (db.stats.totalConnections || 0) + 1;
  saveDB();

  // Track connection time
  const connectionTime = new Date().toISOString();

  // Enhanced connection state tracking
  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${socket.id} (Reason: ${reason})`);
    cleanupSocketRooms(socket.id);
  });

  socket.on('error', (err) => {
    console.error(`Socket error (${socket.id}):`, err);
  });

  // Room management with validation
  socket.on('create', (room, callback) => {
    try {
      if (!room || typeof room !== 'string' || room.length < 4) {
        throw new Error('Invalid room code');
      }

      if (db.rooms[room]) {
        throw new Error('Room already exists');
      }

      console.log(`Creating room: ${room}`);
      socket.join(room);
      db.rooms[room] = {
        createdAt: new Date().toISOString(),
        participants: [socket.id],
        creator: socket.id
      };
      saveDB();

      callback({ success: true, room });
    } catch (err) {
      console.error('Error creating room:', err);
      callback({ success: false, error: err.message });
    }
  });

  socket.on('join', (room, callback) => {
    try {
      if (!room || typeof room !== 'string') {
        throw new Error('Invalid room code');
      }

      console.log(`${socket.id} attempting to join room: ${room}`);
      
      if (!db.rooms[room]) {
        throw new Error('Room does not exist');
      }
      
      const roomObj = db.rooms[room];
      if (roomObj.participants.length >= 2) {
        throw new Error('Room is full');
      }
      
      socket.join(room);
      roomObj.participants.push(socket.id);
      saveDB();
      
      // Check for offline messages
      if (db.offlineMessages[room]?.length > 0) {
        socket.emit('pending_messages', db.offlineMessages[room]);
        delete db.offlineMessages[room];
        saveDB();
      }
      
      // Notify both users
      io.to(room).emit('joined', room);
      
      // If this is the second user, notify the first user
      if (roomObj.participants.length === 2) {
        io.to(roomObj.participants[0]).emit('peer_joined');
        db.stats.totalCalls = (db.stats.totalCalls || 0) + 1;
        saveDB();
      }
      
      callback({ success: true, room });
    } catch (err) {
      console.error('Error joining room:', err);
      callback({ success: false, error: err.message });
      socket.emit('error', err.message);
    }
  });

  // WebRTC signaling with validation
  socket.on('offer', (data, callback) => {
    try {
      if (!data.room || !data.offer) {
        throw new Error('Invalid offer data');
      }

      if (!db.rooms[data.room]?.participants.includes(socket.id)) {
        throw new Error('Not a room participant');
      }

      console.log(`Forwarding offer in room: ${data.room}`);
      socket.to(data.room).emit('offer', data);
      callback({ success: true });
    } catch (err) {
      console.error('Error handling offer:', err);
      callback({ success: false, error: err.message });
    }
  });

  socket.on('answer', (data, callback) => {
    try {
      if (!data.room || !data.answer) {
        throw new Error('Invalid answer data');
      }

      if (!db.rooms[data.room]?.participants.includes(socket.id)) {
        throw new Error('Not a room participant');
      }

      console.log(`Forwarding answer in room: ${data.room}`);
      socket.to(data.room).emit('answer', data);
      callback({ success: true });
    } catch (err) {
      console.error('Error handling answer:', err);
      callback({ success: false, error: err.message });
    }
  });

  socket.on('ice', (data, callback) => {
    try {
      if (!data.room || !data.candidate) {
        throw new Error('Invalid ICE candidate data');
      }

      if (!db.rooms[data.room]?.participants.includes(socket.id)) {
        throw new Error('Not a room participant');
      }

      console.log(`Forwarding ICE candidate in room: ${data.room}`);
      socket.to(data.room).emit('ice', data);
      callback({ success: true });
    } catch (err) {
      console.error('Error handling ICE candidate:', err);
      callback({ success: false, error: err.message });
    }
  });

  // Call recording notifications
  socket.on('recording_started', (room, callback) => {
    try {
      if (!db.rooms[room]?.participants.includes(socket.id)) {
        throw new Error('Not a room participant');
      }

      console.log(`Recording started in room: ${room}`);
      socket.to(room).emit('recording_notification', 'Recording has started');
      callback({ success: true });
    } catch (err) {
      console.error('Error handling recording start:', err);
      callback({ success: false, error: err.message });
    }
  });

  socket.on('recording_stopped', (room, callback) => {
    try {
      if (!db.rooms[room]?.participants.includes(socket.id)) {
        throw new Error('Not a room participant');
      }

      console.log(`Recording stopped in room: ${room}`);
      socket.to(room).emit('recording_notification', 'Recording has stopped');
      callback({ success: true });
    } catch (err) {
      console.error('Error handling recording stop:', err);
      callback({ success: false, error: err.message });
    }
  });

  // Offline messaging
  socket.on('leave_message', ({ room, message }, callback) => {
    try {
      if (!room || !message) {
        throw new Error('Invalid message data');
      }

      if (!db.rooms[room]) {
        throw new Error('Room does not exist');
      }

      if (!db.offlineMessages[room]) {
        db.offlineMessages[room] = [];
      }
      
      db.offlineMessages[room].push({
        from: socket.id,
        message,
        timestamp: new Date().toISOString()
      });
      saveDB();
      
      socket.to(room).emit('offline_message', { from: socket.id, message });
      callback({ success: true });
    } catch (err) {
      console.error('Error handling offline message:', err);
      callback({ success: false, error: err.message });
    }
  });

  // Call status updates
  socket.on('call_connected', (room, callback) => {
    try {
      const roomObj = db.rooms[room];
      if (roomObj) {
        roomObj.connectedAt = new Date().toISOString();
        saveDB();
        callback({ success: true });
      } else {
        throw new Error('Room not found');
      }
    } catch (err) {
      console.error('Error updating call connection:', err);
      callback({ success: false, error: err.message });
    }
  });

  // Handle explicit leave with cleanup
  socket.on('leave', (room, callback) => {
    try {
      console.log(`${socket.id} leaving room: ${room}`);
      socket.leave(room);
      cleanupRoom(room, socket.id);
      socket.to(room).emit('leave');
      callback({ success: true });
    } catch (err) {
      console.error('Error handling leave:', err);
      callback({ success: false, error: err.message });
    }
  });

  // Helper function to clean up rooms when a socket disconnects
  function cleanupSocketRooms(socketId) {
    for (const room in db.rooms) {
      const index = db.rooms[room].participants.indexOf(socketId);
      if (index !== -1) {
        db.rooms[room].participants.splice(index, 1);
        
        // Notify other participants
        io.to(room).emit('leave');
        
        // If room is now empty, record call duration
        if (db.rooms[room].participants.length === 0 && db.rooms[room].connectedAt) {
          finalizeCallRecord(room);
        }
        
        saveDB();
      }
    }
  }

  // Helper function to finalize call records
  function finalizeCallRecord(room) {
    const roomObj = db.rooms[room];
    if (roomObj && roomObj.connectedAt) {
      const startTime = new Date(roomObj.connectedAt);
      const endTime = new Date();
      const duration = (endTime - startTime) / 1000; // in seconds
      
      db.callRecords.push({
        room,
        startTime: roomObj.connectedAt,
        endTime: endTime.toISOString(),
        duration,
        participants: roomObj.participants
      });
      
      delete db.rooms[room];
      saveDB();
    }
  }

  // Helper function to clean up a specific room
  function cleanupRoom(room, socketId) {
    const roomObj = db.rooms[room];
    if (roomObj) {
      const index = roomObj.participants.indexOf(socketId);
      if (index !== -1) {
        roomObj.participants.splice(index, 1);
        
        // If room is now empty, record call duration
        if (roomObj.participants.length === 0 && roomObj.connectedAt) {
          finalizeCallRecord(room);
        }
        
        saveDB();
      }
    }
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Database file: ${dbFile}`);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('Saving database before shutdown...');
  saveDB();
  process.exit();
});
