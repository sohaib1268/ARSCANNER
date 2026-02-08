const mongoose = require('mongoose');

const objectSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  imageUrls: [{
    type: String
  }],
  modelUrl: {
    type: String,
    required: false,
    default: ''
  },
  // --- 3D generation tracking ---
  generationStatus: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending'
  },
  generationTaskId: {
    type: String,
    default: ''
  },
  generationMethod: {
    type: String,
    enum: ['meshy', 'tripo', 'local', ''],
    default: ''
  },
  generationProgress: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  generationError: {
    type: String,
    default: ''
  },
  generationTime: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Object', objectSchema);
