# RoomSnap AR

An AI-powered AR application for creating 3D models from photos and placing them in augmented reality.

## Features

- **AI 3D Reconstruction** - Generate realistic 3D models from photos using Meshy.ai or Tripo AI
- **3D Model Viewer** - Interactive viewer with touch-based rotation and scaling
- **AR Placement** - Place 3D models in your environment with device motion tracking
- **Intuitive Controls** - Gesture-based rotation/scaling with position fine-tuning buttons
- **Screenshot Capture** - Save AR scenes with camera composite rendering

## Project Structure

```
ARScanner/
├── backend/          # Node.js + Express backend
│   ├── src/
│   │   ├── models/   # MongoDB models
│   │   ├── routes/   # API endpoints
│   │   ├── services/ # AI model generation (Meshy, Tripo)
│   │   └── utils/    # Upload handling
│   └── uploads/      # Static file storage
│
└── frontend/         # React Native + Expo frontend
    ├── src/
    │   ├── screens/  # UI screens (Home, CreateObject, ObjectLibrary, ModelViewer, ARView)
    │   ├── services/ # API client
    │   ├── navigation/
    │   └── utils/    # DOM polyfill patches
    └── App.js
```

## Prerequisites

### Backend
- Node.js 18+
- MongoDB 5+
- **At least one API key**: Meshy.ai OR Tripo AI (for 3D reconstruction)

### Frontend
- Node.js 18+
- Expo CLI
- iOS device with ARKit support (iPhone 6S or newer) or Android device
- Xcode (for iOS development)
- brew install watchman , Prevents "too many open files" error


## Backend Setup

1. Navigate to backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file:
```bash
cp .env.example .env
```

4. Edit `.env` with your settings:
```
PORT=3000
MONGODB_URI=mongodb://localhost:27017/roomsnap
NODE_ENV=development

# API Keys - at least one is required
MESHY_API_KEY=your_meshy_api_key_here
TRIPO_API_KEY=your_tripo_api_key_here
```

**Getting API Keys:**
- Meshy.ai: https://meshy.ai
- Tripo AI: https://tripo.ai

5. Start MongoDB:
```bash
# Using Homebrew on macOS
brew services start mongodb-community

# Or using Docker
docker run -d -p 27017:27017 --name mongodb mongo:latest
```

6. Start the backend server:
```bash
npm start
```

Backend should be running on `http://localhost:3000`

### Backend API Endpoints

**Objects:**
- `POST /api/objects` - Create object with images (async generation)
- `GET /api/objects` - Fetch all objects
- `GET /api/objects/:id` - Get single object
- `GET /api/objects/:id/status` - Poll generation status
- `POST /api/objects/:id/regenerate` - Retry failed generation
- `DELETE /api/objects/:id` - Delete object

**Health:**
- `GET /health` - Backend health check

## Frontend Setup

1. Navigate to frontend directory:
```bash
cd frontend
```

2. Install dependencies:
```bash
npm install
```

3. Update API base URL (if needed):

Edit `src/services/api.js` and update `API_BASE_URL`:
```javascript
const API_BASE_URL = 'http://localhost:3000/api';
```

**Important:** When testing on a physical device, use your computer's local network IP address (e.g., `http://192.168.1.100:3000/api`), not `localhost`.

4. Install Expo CLI (if not already installed):
```bash
npm install -g expo-cli
```

5. Start Expo:
```bash
npm start
```

6. Run on Android/iOS:
```
scan the QR code with Expo Go app
```

## Usage Flow

### 1. Create 3D Model
- Tap "Create New Object" on home screen
- Upload 1-4 photos of the object from different angles
- Enter a name for the object
- Submit to start AI 3D reconstruction
- Wait 1-3 minutes for generation (progress shown with live updates)

### 2. View Object Library
- Tap "View Object Library" to see all created objects
- Each object shows:
  - Thumbnail image
  - Name and creation date
  - Generation status (processing/completed/failed)
  - Progress bar for in-progress generations
- Pull down to refresh and update statuses

### 3. View 3D Model
- Tap "View 3D" on any completed object
- Interactive 3D viewer with:
  - **Drag** to rotate model
  - **Pinch** to scale
  - "Reset Camera" button to restore default view
  - "Back" button to return to library

### 4. View in AR
- Tap "View in AR" on any completed object
- Point camera at a surface
- Tap "Tap to Place" to position the model
- Use touch gestures:
  - **One-finger drag** to rotate freely
  - **Two-finger pinch** to scale (0.2x - 5.0x)
- Fine-tune position with arrow buttons:
  - **← →** Move left/right
  - **↑ ↓** Move forward/backward
- Tap camera button to capture AR screenshot
- Tap X to exit AR

## Controls

### 3D Model Viewer
- **Drag**: Rotate model around center
- **Pinch**: Scale model in/out
- **Reset Camera**: Restore default view angle

### AR View
- **One-finger drag**: Rotate model on X and Y axes
- **Two-finger pinch**: Scale model (constrained 0.2x - 5.0x)
- **Arrow buttons**: Fine-tune position in 10cm increments
  - Left/Right: Move along X axis
  - Forward/Back: Move along Z axis
- **Camera button**: Capture AR screenshot (saved to Photos)

## Technical Details

### 3D Model Generation
- Uses Meshy.ai or Tripo AI for photogrammetry-based 3D reconstruction
- Fallback order: Meshy → Tripo (whichever is configured first)
- Generation time: 30-180 seconds depending on API
- Output format: GLB (GL Transmission Format)
- Async generation with polling for status updates

### AR Implementation
- Device motion tracking using expo-sensors
- Camera-relative placement (2.5m in front of view direction)
- Manual GLB parser (avoids DOM dependency issues)
- Transparent GL overlay over native camera view
- Screenshot compositing via React Native Image layers

### Key Dependencies
- **Frontend**: expo-gl, expo-three, three.js, react-native-gesture-handler
- **Backend**: mongoose, multer, axios, sharp (image preprocessing)

## Troubleshooting

### Backend Issues

**No API keys configured:**
```
Error: No 3D reconstruction API keys configured
```
Solution: Add MESHY_API_KEY or TRIPO_API_KEY to `.env`

**MongoDB connection error:**
```bash
# Check MongoDB is running
brew services list | grep mongodb

# Restart MongoDB
brew services restart mongodb-community
```

**Port already in use:**
```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9
```

### Frontend Issues

**Cannot connect to backend:**
- Ensure backend is running (`npm start` in backend/)
- Use computer's IP address, not localhost (for physical device)
- Check firewall settings allow port 3000
- Verify both devices on same network

**AR not working:**
- Test on physical iOS device Or Android Device (simulator doesn't support ARKit)
- Ensure device supports ARKit (iPhone 6S or newer)
- Grant camera permissions when prompted
- Check device motion sensors are enabled

**Model not loading in AR:**
- Check object generation status in library
- Verify backend logs for model generation errors
- Ensure GLB file exists in `backend/uploads/models/`
- Check API key validity

**"document.getElementById(id)?.remove is not a function" error:**
- This is handled by `patchBrowserPolyfill.js`
- Ensure it's imported first in `App.js`
- Don't modify import order

**Model appears black or wrong colors:**
- Check GLB file has materials with baseColorFactor
- Verify model loaded correctly (check console logs)
- Try regenerating the model

## Development

### Backend Development
```bash
cd backend
npm run dev  # Uses nodemon for auto-reload
```

### Frontend Development
```bash
cd frontend
npm start    # Start Expo dev server
```

### Testing Backend API
```bash
# Health check
curl http://localhost:3000/health

# Get all objects
curl http://localhost:3000/api/objects

# Check generation status
curl http://localhost:3000/api/objects/<object_id>/status
```

## Known Limitations

- **Single object per AR session** - One model at a time in AR view
- **API rate limits** - Subject to Meshy/Tripo API quotas
- **Generation time** - 1-3 minutes depending on API load
- **No persistent AR anchors** - Models reset on app restart

## Future Enhancements

Potential improvements for future versions:
- Multi-object AR placement
- Persistent AR anchors with cloud storage
- Object scanning with LiDAR
- Real-time lighting and occlusion
- Social sharing features
- User authentication and cloud sync

## License

MIT
