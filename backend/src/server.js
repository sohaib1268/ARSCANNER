require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const objectRoutes = require('./routes/objectRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Increase timeout for long-running 3D generation requests (5 minutes)
app.use((req, res, next) => {
  res.setTimeout(300000); // 5 minutes
  next();
});

// Serve static files for uploaded images and models
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Routes
app.use('/api/objects', objectRoutes);

// Health check
app.get('/health', (req, res) => {
  const meshyConfigured = !!process.env.MESHY_API_KEY;
  const tripoConfigured = !!process.env.TRIPO_API_KEY;

  res.json({
    status: 'ok',
    message: 'RoomSnap AR Backend - 3D Reconstruction',
    services: {
      meshy: meshyConfigured ? 'configured' : 'not configured',
      tripo: tripoConfigured ? 'configured' : 'not configured',
      reconstruction: meshyConfigured || tripoConfigured ? 'AI-powered' : 'local fallback only'
    }
  });
});

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/roomsnap')
  .then(() => {
    console.log('[Server] Connected to MongoDB');
    app.listen(PORT, () => {
      console.log(`[Server] Running on port ${PORT}`);
      console.log(`[Server] Health check: http://localhost:${PORT}/health`);
    });
  })
  .catch((error) => {
    console.error('[Server] MongoDB connection error:', error);
    process.exit(1);
  });

module.exports = app;
