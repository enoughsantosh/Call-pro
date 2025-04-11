const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const path = require('path');
const fs = require('fs');

// Database for storing call records and offline messages
const dbFile = path.join(__dirname, 'db.json');
let db = {
  callRecords: [],
  offlineMessages: {},
  rooms: {}
};

// Load existing database if it exists
if (fs.existsSync(dbFile)) {
  db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
}

// Helper function to save database
function saveDB() {
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint to get call history
app.get('/api/call-history', (req, res) => {
  res.json(db.callRecords.slice(-20).reverse()); // Return last 20 calls
});

// API endpoint to get offline messages
app.get('/api/offline-messages/:room', (req, res) => {
  const messages = db.offlineMessages[req.params.room] || [];
  res.json(messages);
});

// WebSocket signaling logic
io.on('connection', socket => {
  console.log(`New connection: ${socket.id}`);
  
  // Track connection time
  const connectionTime = new Date().toISOString();
  
  // Handle reconnection
  socket.on('reconnect_attempt', () => {
    socket.emit('reconnecting');
  });

  socket.on('reconnect', () => {
    socket.emit('reconnected');
  });

  // Room management
  socket.on('create', room => {
    console.log(`Creating room: ${room}`);
    socket.join(room);
    db.rooms[room] = {
      createdAt: new Date().toISOString(),
      participants: [socket.id]
    };
    saveDB();
  });

  socket.on('join', room => {
    console.log(`${socket.id} joining room: ${room}`);
    
    if (!db.rooms[room]) {
      socket.emit('error', 'Room does not exist');
      return;
    }
    
    const roomObj = db.rooms[room];
    if (roomObj.participants.length >= 2) {
      socket.emit('full');
      return;
    }
    
    socket.join(room);
    roomObj.participants.push(socket.id);
    saveDB();
    
    // Check for offline messages
    if (db.offlineMessages[room] && db.offlineMessages[room].length > 0) {
      socket.emit('pending_messages', db.offlineMessages[room]);
      delete db.offlineMessages[room];
      saveDB();
    }
    
    socket.emit('joined', room);
    socket.to(room).emit('joined', room);
  });

  // WebRTC signaling
  socket.on('offer', data => {
    socket.to(data.room).emit('offer', data);
  });

  socket.on('answer', data => {
    socket.to(data.room).emit('answer', data);
  });

  socket.on('ice', data => {
    socket.to(data.room).emit('ice', data);
  });

  socket.on('ready', room => {
    socket.to(room).emit('ready');
  });

  // Call recording notifications
  socket.on('recording_started', room => {
    socket.to(room).emit('recording_notification', 'Recording has started');
  });

  socket.on('recording_stopped', room => {
    socket.to(room).emit('recording_notification', 'Recording has stopped');
  });

  // Offline messaging
  socket.on('leave_message', ({ room, message }) => {
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
  });

  // Call status updates
  socket.on('call_connected', room => {
    const roomObj = db.rooms[room];
    if (roomObj) {
      roomObj.connectedAt = new Date().toISOString();
      saveDB();
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    
    // Find and clean up any rooms this socket was in
    for (const room in db.rooms) {
      const index = db.rooms[room].participants.indexOf(socket.id);
      if (index !== -1) {
        db.rooms[room].participants.splice(index, 1);
        
        // Notify other participants
        socket.to(room).emit('leave');
        
        // If room is now empty, record call duration
        if (db.rooms[room].participants.length === 0 && db.rooms[room].connectedAt) {
          const startTime = new Date(db.rooms[room].connectedAt);
          const endTime = new Date();
          const duration = (endTime - startTime) / 1000; // in seconds
          
          db.callRecords.push({
            room,
            startTime: db.rooms[room].connectedAt,
            endTime: endTime.toISOString(),
            duration,
            participants: db.rooms[room].participants
          });
          
          delete db.rooms[room];
        }
        
        saveDB();
      }
    }
  });

  // Handle explicit leave
  socket.on('leave', room => {
    socket.leave(room);
    const roomObj = db.rooms[room];
    if (roomObj) {
      const index = roomObj.participants.indexOf(socket.id);
      if (index !== -1) {
        roomObj.participants.splice(index, 1);
        
        // If room is now empty, record call duration
        if (roomObj.participants.length === 0 && roomObj.connectedAt) {
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
        }
        
        saveDB();
      }
    }
    socket.to(room).emit('leave');
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Use Render's provided port
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Database file: ${dbFile}`);
});
