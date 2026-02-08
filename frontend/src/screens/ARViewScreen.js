// IMPORTANT: Import polyfill patch BEFORE expo-three to fix
// "document.getElementById(id)?.remove is not a function" error
import '../utils/patchBrowserPolyfill';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Text,
  Image,
  ActivityIndicator,
  Alert,
  PanResponder,
  Dimensions,
  Animated,
  Platform,
} from 'react-native';
import { GLView } from 'expo-gl';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as THREE from 'three';
import { Renderer } from 'expo-three';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { captureRef } from 'react-native-view-shot';
import { DeviceMotion } from 'expo-sensors';
import apiService from '../services/api';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// GLB binary parser (works without DOM APIs, no GLTFLoader needed)
const GLB_MAGIC = 0x46546C67; // 'glTF' in little-endian
const CHUNK_TYPE_JSON = 0x4E4F534A;
const CHUNK_TYPE_BIN = 0x004E4942;

const COMPONENT_TYPES = {
  5120: { array: Int8Array, size: 1 },
  5121: { array: Uint8Array, size: 1 },
  5122: { array: Int16Array, size: 2 },
  5123: { array: Uint16Array, size: 2 },
  5125: { array: Uint32Array, size: 4 },
  5126: { array: Float32Array, size: 4 },
};

const TYPE_SIZES = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

function readAccessor(gltf, binaryData, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex];
  const bufferView = gltf.bufferViews[accessor.bufferView];

  const componentInfo = COMPONENT_TYPES[accessor.componentType];
  if (!componentInfo) {
    throw new Error(`Unsupported component type: ${accessor.componentType}`);
  }

  const numComponents = TYPE_SIZES[accessor.type];
  if (!numComponents) {
    throw new Error(`Unsupported accessor type: ${accessor.type}`);
  }

  const byteOffset =
    (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
  const count = accessor.count;
  const byteStride = bufferView.byteStride || 0;

  const tightStride = componentInfo.size * numComponents;
  const totalElements = count * numComponents;
  const totalBytes = totalElements * componentInfo.size;

  // Validate that the read region falls within the binary chunk
  if (byteOffset + totalBytes > binaryData.byteLength) {
    console.warn(
      `readAccessor: accessor ${accessorIndex} overflows binary chunk ` +
      `(offset=${byteOffset}, need=${totalBytes}, have=${binaryData.byteLength}). Clamping.`
    );
  }

  if (byteStride === 0 || byteStride === tightStride) {
    // Even for tightly-packed data we must copy into a fresh buffer because:
    //   1. The absolute byte offset (binaryData.byteOffset + byteOffset)
    //      may not satisfy the alignment requirement of the typed array
    //      (e.g. Float32Array needs 4-byte alignment).
    //   2. The slice may extend past the underlying ArrayBuffer boundary
    //      when binaryData is itself a view with a non-zero byteOffset.
    // Copying a Uint8Array slice and then viewing it as the target type
    // guarantees correct alignment and safe bounds.
    const srcStart = byteOffset;
    const srcEnd = Math.min(srcStart + totalBytes, binaryData.byteLength);
    const slice = binaryData.slice(srcStart, srcEnd);
    return new componentInfo.array(slice.buffer, 0, totalElements);
  }

  // Interleaved data - copy element by element using DataView
  const result = new componentInfo.array(totalElements);
  const dataView = new DataView(
    binaryData.buffer,
    binaryData.byteOffset,
    binaryData.byteLength
  );

  for (let i = 0; i < count; i++) {
    const elementOffset = byteOffset + i * byteStride;
    for (let j = 0; j < numComponents; j++) {
      const compOffset = elementOffset + j * componentInfo.size;
      // Bounds check to avoid reading past the binary chunk
      if (compOffset + componentInfo.size > binaryData.byteLength) {
        console.warn(
          `readAccessor: interleaved read out of bounds at element ${i}, component ${j}`
        );
        break;
      }
      switch (accessor.componentType) {
        case 5126:
          result[i * numComponents + j] = dataView.getFloat32(compOffset, true);
          break;
        case 5123:
          result[i * numComponents + j] = dataView.getUint16(compOffset, true);
          break;
        case 5125:
          result[i * numComponents + j] = dataView.getUint32(compOffset, true);
          break;
        case 5121:
          result[i * numComponents + j] = dataView.getUint8(compOffset);
          break;
        case 5122:
          result[i * numComponents + j] = dataView.getInt16(compOffset, true);
          break;
        case 5120:
          result[i * numComponents + j] = dataView.getInt8(compOffset);
          break;
      }
    }
  }
  return result;
}

function parseGLB(arrayBuffer) {
  const dataView = new DataView(arrayBuffer);

  const magic = dataView.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    throw new Error(
      'Invalid GLB file: bad magic number 0x' + magic.toString(16)
    );
  }

  const version = dataView.getUint32(4, true);
  if (version !== 2) {
    throw new Error('Unsupported GLB version: ' + version);
  }

  const totalLength = dataView.getUint32(8, true);

  let jsonChunk = null;
  let binaryChunk = null;
  let offset = 12;

  while (offset < totalLength) {
    const chunkLength = dataView.getUint32(offset, true);
    const chunkType = dataView.getUint32(offset + 4, true);

    if (chunkType === CHUNK_TYPE_JSON) {
      const jsonBytes = new Uint8Array(arrayBuffer, offset + 8, chunkLength);
      let jsonString = '';
      for (let i = 0; i < jsonBytes.length; i++) {
        jsonString += String.fromCharCode(jsonBytes[i]);
      }
      jsonChunk = JSON.parse(jsonString);
    } else if (chunkType === CHUNK_TYPE_BIN) {
      binaryChunk = new Uint8Array(arrayBuffer, offset + 8, chunkLength);
    }

    offset += 8 + chunkLength;
  }

  if (!jsonChunk) {
    throw new Error('GLB file has no JSON chunk');
  }

  return { gltfJson: jsonChunk, binaryData: binaryChunk };
}

function buildSceneFromGLTF(gltfJson, binaryData) {
  const group = new THREE.Group();

  if (!gltfJson.meshes || gltfJson.meshes.length === 0) {
    throw new Error('GLB contains no meshes');
  }

  if (gltfJson.nodes && gltfJson.scenes) {
    const sceneIndex =
      gltfJson.scene !== undefined ? gltfJson.scene : 0;
    const scene = gltfJson.scenes[sceneIndex];

    if (scene && scene.nodes) {
      for (const nodeIndex of scene.nodes) {
        const nodeObj = processNode(gltfJson, binaryData, nodeIndex);
        if (nodeObj) group.add(nodeObj);
      }
      return group;
    }
  }

  // Fallback: iterate meshes directly
  for (const mesh of gltfJson.meshes) {
    for (const primitive of mesh.primitives) {
      const threeMesh = buildPrimitive(gltfJson, binaryData, primitive);
      if (threeMesh) group.add(threeMesh);
    }
  }

  return group;
}

function processNode(gltfJson, binaryData, nodeIndex) {
  const node = gltfJson.nodes[nodeIndex];
  if (!node) return null;

  let obj;

  if (node.mesh !== undefined) {
    const meshDef = gltfJson.meshes[node.mesh];
    obj = new THREE.Group();
    for (const primitive of meshDef.primitives) {
      const threeMesh = buildPrimitive(gltfJson, binaryData, primitive);
      if (threeMesh) obj.add(threeMesh);
    }
  } else {
    obj = new THREE.Group();
  }

  if (node.matrix) {
    const m = new THREE.Matrix4();
    m.fromArray(node.matrix);
    obj.applyMatrix4(m);
  } else {
    if (node.translation) {
      obj.position.fromArray(node.translation);
    }
    if (node.rotation) {
      obj.quaternion.fromArray(node.rotation);
    }
    if (node.scale) {
      obj.scale.fromArray(node.scale);
    }
  }

  if (node.children) {
    for (const childIndex of node.children) {
      const child = processNode(gltfJson, binaryData, childIndex);
      if (child) obj.add(child);
    }
  }

  return obj;
}

function buildPrimitive(gltfJson, binaryData, primitive) {
  if (!binaryData) {
    throw new Error('GLB has no binary data chunk');
  }

  const geometry = new THREE.BufferGeometry();

  if (primitive.attributes.POSITION !== undefined) {
    const positions = readAccessor(
      gltfJson,
      binaryData,
      primitive.attributes.POSITION
    );
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(positions), 3)
    );
  } else {
    console.warn('Primitive has no POSITION attribute, skipping');
    return null;
  }

  if (primitive.attributes.NORMAL !== undefined) {
    const normals = readAccessor(
      gltfJson,
      binaryData,
      primitive.attributes.NORMAL
    );
    geometry.setAttribute(
      'normal',
      new THREE.BufferAttribute(new Float32Array(normals), 3)
    );
  }

  if (primitive.attributes.TEXCOORD_0 !== undefined) {
    const uvs = readAccessor(
      gltfJson,
      binaryData,
      primitive.attributes.TEXCOORD_0
    );
    geometry.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array(uvs), 2)
    );
  }

  if (primitive.attributes.COLOR_0 !== undefined) {
    const colors = readAccessor(
      gltfJson,
      binaryData,
      primitive.attributes.COLOR_0
    );
    const accessor = gltfJson.accessors[primitive.attributes.COLOR_0];
    const numComponents = TYPE_SIZES[accessor.type];

    let colorArray;
    if (accessor.componentType === 5121) {
      colorArray = new Float32Array(colors.length);
      for (let i = 0; i < colors.length; i++) {
        colorArray[i] = colors[i] / 255;
      }
    } else if (accessor.componentType === 5123) {
      colorArray = new Float32Array(colors.length);
      for (let i = 0; i < colors.length; i++) {
        colorArray[i] = colors[i] / 65535;
      }
    } else {
      colorArray = new Float32Array(colors);
    }

    geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(colorArray, numComponents)
    );
  }

  if (primitive.indices !== undefined) {
    const indices = readAccessor(
      gltfJson,
      binaryData,
      primitive.indices
    );
    const accessor = gltfJson.accessors[primitive.indices];
    let indexArray;
    if (accessor.componentType === 5125) {
      indexArray = new Uint32Array(indices);
    } else {
      indexArray = new Uint16Array(indices);
    }
    geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
  }

  if (primitive.attributes.NORMAL === undefined) {
    geometry.computeVertexNormals();
  }

  const material = buildMaterial(gltfJson, primitive);

  return new THREE.Mesh(geometry, material);
}

function buildMaterial(gltfJson, primitive) {
  const materialProps = { side: THREE.DoubleSide };

  if (primitive.material !== undefined && gltfJson.materials) {
    const mat = gltfJson.materials[primitive.material];
    if (mat.pbrMetallicRoughness) {
      const pbr = mat.pbrMetallicRoughness;
      if (pbr.baseColorFactor) {
        const [r, g, b, a] = pbr.baseColorFactor;
        materialProps.color = new THREE.Color(r, g, b);
        if (a < 1.0) {
          materialProps.transparent = true;
          materialProps.opacity = a;
        }
      }
      materialProps.metalness =
        pbr.metallicFactor !== undefined ? pbr.metallicFactor : 0.0;
      materialProps.roughness =
        pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 1.0;
    }

    // Handle alpha mode from material definition
    if (mat.alphaMode === 'BLEND') {
      materialProps.transparent = true;
      if (mat.alphaCutoff !== undefined) {
        materialProps.alphaTest = mat.alphaCutoff;
      }
    } else if (mat.alphaMode === 'MASK') {
      materialProps.alphaTest =
        mat.alphaCutoff !== undefined ? mat.alphaCutoff : 0.5;
    }

    // Handle double-sided flag from material
    if (mat.doubleSided === false) {
      materialProps.side = THREE.FrontSide;
    }
  }

  // Default color if none specified
  if (!materialProps.color) {
    materialProps.color = new THREE.Color(0xcccccc);
  }

  // Subtle emissive for visibility in AR (prevents model looking too dark)
  materialProps.emissive = new THREE.Color(0x111111);
  materialProps.emissiveIntensity = 0.2;

  return new THREE.MeshStandardMaterial(materialProps);
}

/**
 * Normalize and center a model to fit within a target bounding sphere.
 * The model is centered on the XZ plane and placed so its bottom sits at y=0,
 * which makes AR surface placement work correctly (model rests ON the surface).
 * Returns the original dimensions before normalization.
 */
function normalizeModel(group, targetSize = 1.5) {
  const box = new THREE.Box3().setFromObject(group);
  const center = new THREE.Vector3();
  box.getCenter(center);

  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);

  if (maxDim === 0) return { width: 0, height: 0, depth: 0 };

  // STEP 1: Adjust child positions BEFORE scaling (using original bbox)
  const offsetX = -center.x;
  const offsetZ = -center.z;
  const offsetY = -box.min.y; // Shift up so bottom is at y=0

  group.traverse((child) => {
    if (child !== group && child.parent === group) {
      child.position.x += offsetX;
      child.position.z += offsetZ;
      child.position.y += offsetY;
    }
  });

  // STEP 2: Now scale the group (after children are positioned)
  const scale = targetSize / maxDim;
  group.scale.multiplyScalar(scale);

  console.log('AR: normalizeModel scale=' + scale.toFixed(4) +
    ' size=' + (size.x * scale).toFixed(2) + 'x' + (size.y * scale).toFixed(2) + 'x' + (size.z * scale).toFixed(2));

  return {
    width: size.x.toFixed(3),
    height: size.y.toFixed(3),
    depth: size.z.toFixed(3),
  };
}

/**
 * Create a circular reticle (placement indicator) with animated ring.
 */
function createReticle() {
  const group = new THREE.Group();

  // Outer ring
  const ringGeometry = new THREE.RingGeometry(0.12, 0.14, 32);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0x00ff88,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
  });
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  // Inner dot
  const dotGeometry = new THREE.CircleGeometry(0.02, 16);
  const dotMaterial = new THREE.MeshBasicMaterial({
    color: 0x00ff88,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
  });
  const dot = new THREE.Mesh(dotGeometry, dotMaterial);
  dot.rotation.x = -Math.PI / 2;
  dot.position.y = 0.001;
  group.add(dot);

  // Crosshair lines
  const linesMaterial = new THREE.LineBasicMaterial({
    color: 0x00ff88,
    transparent: true,
    opacity: 0.6,
  });

  // Horizontal crosshair
  const hPoints = [
    new THREE.Vector3(-0.08, 0.001, 0),
    new THREE.Vector3(-0.03, 0.001, 0),
  ];
  const hPoints2 = [
    new THREE.Vector3(0.03, 0.001, 0),
    new THREE.Vector3(0.08, 0.001, 0),
  ];
  const hGeom = new THREE.BufferGeometry().setFromPoints(hPoints);
  const hGeom2 = new THREE.BufferGeometry().setFromPoints(hPoints2);
  group.add(new THREE.Line(hGeom, linesMaterial));
  group.add(new THREE.Line(hGeom2, linesMaterial));

  // Vertical crosshair
  const vPoints = [
    new THREE.Vector3(0, 0.001, -0.08),
    new THREE.Vector3(0, 0.001, -0.03),
  ];
  const vPoints2 = [
    new THREE.Vector3(0, 0.001, 0.03),
    new THREE.Vector3(0, 0.001, 0.08),
  ];
  const vGeom = new THREE.BufferGeometry().setFromPoints(vPoints);
  const vGeom2 = new THREE.BufferGeometry().setFromPoints(vPoints2);
  group.add(new THREE.Line(vGeom, linesMaterial));
  group.add(new THREE.Line(vGeom2, linesMaterial));

  return group;
}

/**
 * Create a subtle surface detection grid visualization.
 */
function createSurfaceGrid() {
  const group = new THREE.Group();

  // Semi-transparent grid plane
  const gridSize = 2;
  const divisions = 20;
  const step = gridSize / divisions;

  const gridMaterial = new THREE.LineBasicMaterial({
    color: 0x00ff88,
    transparent: true,
    opacity: 0.15,
  });

  const points = [];
  const half = gridSize / 2;

  for (let i = 0; i <= divisions; i++) {
    const pos = -half + i * step;
    // Horizontal lines
    points.push(new THREE.Vector3(-half, 0, pos));
    points.push(new THREE.Vector3(half, 0, pos));
    // Vertical lines
    points.push(new THREE.Vector3(pos, 0, -half));
    points.push(new THREE.Vector3(pos, 0, half));
  }

  const gridGeometry = new THREE.BufferGeometry().setFromPoints(points);
  const grid = new THREE.LineSegments(gridGeometry, gridMaterial);
  group.add(grid);

  return group;
}

/**
 * Create a shadow disc to anchor the model visually to the surface.
 */
function createShadowDisc(radius = 0.3) {
  const geometry = new THREE.CircleGeometry(radius, 32);
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.25,
    side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(geometry, material);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.002; // Slightly above surface
  return disc;
}

const AR_STATE = {
  LOADING: 'loading',
  DETECTING: 'detecting',
  READY: 'ready',        // Surface found, showing reticle
  PLACED: 'placed',      // Model placed on surface
  ERROR: 'error',
};

export default function ARViewScreen({ route, navigation }) {
  const { object } = route.params || {};

  if (!object || !object.modelUrl) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>Invalid object data</Text>
        <TouchableOpacity
          style={styles.permissionButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.permissionButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [mediaPermission, setMediaPermission] = useState(null);

  const [arState, setArState] = useState(AR_STATE.LOADING);
  const [statusMessage, setStatusMessage] = useState('Loading model...');
  const [modelDimensions, setModelDimensions] = useState(null);
  const [uiVisible, setUiVisible] = useState(true);

  const [compositePhotos, setCompositePhotos] = useState(null);

  const captureViewRef = useRef(null);
  const compositeViewRef = useRef(null);
  const glViewRef = useRef(null);
  const cameraNativeRef = useRef(null);
  const mountedRef = useRef(true);
  const animFrameRef = useRef(null);

  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const glRef = useRef(null);

  const modelGroupRef = useRef(null);
  const placedModelRef = useRef(null);
  const reticleRef = useRef(null);
  const surfaceGridRef = useRef(null);
  const shadowDiscRef = useRef(null);

  const deviceOrientationRef = useRef(null);
  const deviceMotionSubscriptionRef = useRef(null);

  const modelLoadedRef = useRef(false);
  const surfaceDetectedRef = useRef(false);
  const modelPlacedRef = useRef(false);
  const placementPosRef = useRef(new THREE.Vector3(0, 0, -2.5));
  const reticleAnimRef = useRef(0);

  const lastTouchRef = useRef(null);
  const lastPinchDistRef = useRef(null);
  const modelRotationRef = useRef({ x: 0, y: 0 });
  const modelScaleRef = useRef(1.0);
  const modelPositionRef = useRef({ x: 0, z: 0 });

  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    mountedRef.current = true;
    requestCameraPermission();
    (async () => {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      setMediaPermission(status === 'granted');
    })();

    // Pulse animation for reticle indicator
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.3,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    );
    pulse.start();

    return () => {
      mountedRef.current = false;
      pulse.stop();
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, []);

  // Device motion subscription for camera orientation tracking
  useEffect(() => {
    let subscription = null;

    const startDeviceMotion = async () => {
      try {
        const available = await DeviceMotion.isAvailableAsync();
        if (!available) {
          console.warn('AR: DeviceMotion sensor is not available on this device');
          return;
        }

        // Set update interval to ~60fps (16ms)
        DeviceMotion.setUpdateInterval(16);

        subscription = DeviceMotion.addListener((data) => {
          if (data && data.rotation) {
            deviceOrientationRef.current = data.rotation;
          }
        });
        deviceMotionSubscriptionRef.current = subscription;

        console.log('AR: DeviceMotion subscription started (16ms interval)');
      } catch (err) {
        console.warn('AR: Failed to start DeviceMotion:', err);
      }
    };

    startDeviceMotion();

    return () => {
      if (subscription) {
        subscription.remove();
        subscription = null;
      }
      if (deviceMotionSubscriptionRef.current) {
        deviceMotionSubscriptionRef.current.remove();
        deviceMotionSubscriptionRef.current = null;
      }
      console.log('AR: DeviceMotion subscription removed');
    };
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // Only capture moves with meaningful displacement
        return Math.abs(gestureState.dx) > 2 || Math.abs(gestureState.dy) > 2;
      },

      onPanResponderGrant: (evt) => {
        const touches = evt.nativeEvent.touches;
        if (touches.length === 1) {
          lastTouchRef.current = {
            x: touches[0].pageX,
            y: touches[0].pageY,
          };
          lastPinchDistRef.current = null;
        } else if (touches.length === 2) {
          lastTouchRef.current = null;
          const dx = touches[0].pageX - touches[1].pageX;
          const dy = touches[0].pageY - touches[1].pageY;
          lastPinchDistRef.current = Math.sqrt(dx * dx + dy * dy);
        }
      },

      onPanResponderMove: (evt) => {
        if (!modelPlacedRef.current || !placedModelRef.current) return;

        const touches = evt.nativeEvent.touches;

        if (touches.length === 1 && lastTouchRef.current) {
          // One finger drag = Rotate freely (like 3D viewer)
          const dx = touches[0].pageX - lastTouchRef.current.x;
          const dy = touches[0].pageY - lastTouchRef.current.y;

          const sensitivity = 0.008;
          modelRotationRef.current = {
            x: modelRotationRef.current.x + dy * sensitivity,
            y: modelRotationRef.current.y + dx * sensitivity,
          };
          placedModelRef.current.rotation.x = modelRotationRef.current.x;
          placedModelRef.current.rotation.y = modelRotationRef.current.y;

          lastTouchRef.current = {
            x: touches[0].pageX,
            y: touches[0].pageY,
          };
        } else if (touches.length === 2) {
          // Two finger pinch = Scale
          const dx = touches[0].pageX - touches[1].pageX;
          const dy = touches[0].pageY - touches[1].pageY;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (lastPinchDistRef.current !== null) {
            const scaleFactor = dist / lastPinchDistRef.current;
            modelScaleRef.current = Math.max(
              0.2,
              Math.min(5.0, modelScaleRef.current * scaleFactor)
            );
            const s = modelScaleRef.current;
            placedModelRef.current.scale.set(s, s, s);

            if (shadowDiscRef.current) {
              shadowDiscRef.current.scale.set(s, s, s);
            }
          }

          lastPinchDistRef.current = dist;
          lastTouchRef.current = null;
        }
      },

      onPanResponderRelease: () => {
        lastTouchRef.current = null;
        lastPinchDistRef.current = null;
      },
    })
  ).current;

  const handleTapToPlace = useCallback(() => {
    console.log('AR: handleTapToPlace called, arState=', arState,
      'modelLoaded=', modelLoadedRef.current);

    if (!modelLoadedRef.current || !sceneRef.current || !cameraRef.current) {
      console.warn('AR: Cannot place - model not loaded or scene/camera not ready');
      return;
    }

    if (arState === AR_STATE.READY && modelGroupRef.current) {
      // Place model 2.5m in front of camera's current view direction
      const direction = new THREE.Vector3();
      cameraRef.current.getWorldDirection(direction);

      const placementPos = new THREE.Vector3();
      placementPos.copy(cameraRef.current.position);
      placementPos.addScaledVector(direction, 2.5);

      placementPosRef.current.copy(placementPos);

      console.log('AR: Placement - camera pos=(' +
        cameraRef.current.position.x.toFixed(2) + ', ' +
        cameraRef.current.position.y.toFixed(2) + ', ' +
        cameraRef.current.position.z.toFixed(2) + ') dir=(' +
        direction.x.toFixed(2) + ', ' +
        direction.y.toFixed(2) + ', ' +
        direction.z.toFixed(2) + ') -> placing at (' +
        placementPos.x.toFixed(2) + ', ' +
        placementPos.y.toFixed(2) + ', ' +
        placementPos.z.toFixed(2) + ')');

      const clonedModel = modelGroupRef.current.clone();
      const wrapper = new THREE.Group();
      wrapper.add(clonedModel);
      wrapper.position.copy(placementPos);

      wrapper.traverse((child) => {
        if (child.isMesh) {
          child.visible = true;
          child.frustumCulled = false;
          if (child.geometry) {
            child.geometry.computeBoundingSphere();
          }
        }
      });

      sceneRef.current.add(wrapper);
      placedModelRef.current = wrapper;
      modelPlacedRef.current = true;

      const shadow = createShadowDisc(0.35);
      shadow.position.copy(placementPos);
      shadow.position.y = placementPos.y + 0.002;
      sceneRef.current.add(shadow);
      shadowDiscRef.current = shadow;

      if (reticleRef.current) {
        reticleRef.current.visible = false;
      }
      if (surfaceGridRef.current) {
        surfaceGridRef.current.visible = false;
      }

      modelRotationRef.current = { x: 0, y: 0 };
      modelScaleRef.current = 1.0;
      modelPositionRef.current = { x: 0, z: 0 };

      let meshCount = 0;
      wrapper.traverse((child) => {
        if (child.isMesh) meshCount++;
      });
      console.log('AR: Model placed with', meshCount, 'meshes at (' +
        wrapper.position.x.toFixed(2) + ', ' +
        wrapper.position.y.toFixed(2) + ', ' +
        wrapper.position.z.toFixed(2) + ')');

      if (mountedRef.current) {
        setArState(AR_STATE.PLACED);
        setStatusMessage('Model placed! Use controls to adjust.');
      }
    }
  }, [arState]);

  const handleReset = useCallback(() => {
    if (!sceneRef.current) return;

    if (placedModelRef.current) {
      sceneRef.current.remove(placedModelRef.current);
      placedModelRef.current = null;
    }

    if (shadowDiscRef.current) {
      sceneRef.current.remove(shadowDiscRef.current);
      shadowDiscRef.current = null;
    }

    modelPlacedRef.current = false;

    if (reticleRef.current) {
      reticleRef.current.visible = true;
    }
    if (surfaceGridRef.current) {
      surfaceGridRef.current.visible = true;
    }

    modelRotationRef.current = { x: 0, y: 0 };
    modelScaleRef.current = 1.0;
    modelPositionRef.current = { x: 0, z: 0 };

    if (mountedRef.current) {
      setArState(AR_STATE.READY);
      setStatusMessage('Tap to place model');
    }
  }, []);

  const handleCapture = useCallback(async () => {
    try {
      // Check media library permission
      if (!mediaPermission) {
        const { status } = await MediaLibrary.requestPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert(
            'Permission Required',
            'Please grant photo library access to save screenshots.'
          );
          return;
        }
        setMediaPermission(true);
      }

      // Hide UI during capture
      setUiVisible(false);

      // Small delay to let UI hide
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Image-level compositing: camera photo + GL snapshot (transparent)
      // overlaid via a hidden view, then captured with react-native-view-shot.
      // This avoids expo-gl texture upload limitations.
      let savedUri = null;

      if (cameraNativeRef.current && glRef.current) {
        try {
          console.log('AR Capture: Taking camera photo...');
          const photo = await cameraNativeRef.current.takePictureAsync({
            quality: 0.9,
            skipProcessing: true,
          });
          console.log('AR Capture: Camera photo taken:', photo.width, 'x', photo.height);

          console.log('AR Capture: Taking GL snapshot...');
          const glSnapshot = await GLView.takeSnapshotAsync(glRef.current, {
            format: 'png',
            compress: 1.0,
          });
          const glUri = glSnapshot.localUri || glSnapshot.uri;
          console.log('AR Capture: GL snapshot taken:', glUri);

          const compositeWidth = glRef.current.drawingBufferWidth || 1080;
          const compositeHeight = glRef.current.drawingBufferHeight || 1920;

          setCompositePhotos({
            cameraUri: photo.uri,
            glUri: glUri,
            width: compositeWidth,
            height: compositeHeight,
          });

          // Wait for compositing view to render
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (compositeViewRef.current) {
            console.log('AR Capture: Capturing composite view...');
            savedUri = await captureRef(compositeViewRef, {
              format: 'png',
              quality: 1,
              result: 'tmpfile',
            });
            console.log('AR Capture: Composite captured:', savedUri);
          } else {
            console.warn('AR Capture: compositeViewRef not available');
          }

          setCompositePhotos(null);
        } catch (compositeErr) {
          console.warn('AR Capture: Image compositing failed:', compositeErr);
          setCompositePhotos(null);
        }
      }

      // Fallback: use react-native-view-shot on the main view (may show black camera background)
      if (!savedUri && captureViewRef.current) {
        console.log('AR Capture: Using view-shot fallback...');
        savedUri = await captureRef(captureViewRef, {
          format: 'png',
          quality: 1,
          result: 'tmpfile',
        });
      }

      if (!savedUri) {
        throw new Error('No capture method available');
      }

      // Save to gallery
      await MediaLibrary.saveToLibraryAsync(savedUri);

      setUiVisible(true);
      Alert.alert('Saved!', 'AR screenshot saved to your photo library.');
    } catch (error) {
      console.error('Screenshot capture failed:', error);
      setUiVisible(true);
      setCompositePhotos(null);
      Alert.alert('Error', 'Failed to capture screenshot: ' + error.message);
    }
  }, [mediaPermission]);

  const onContextCreate = useCallback(
    async (gl) => {
      if (!mountedRef.current) return;

      // Patch GL context: expo-gl may return null from getShaderInfoLog /
      // getProgramInfoLog, but THREE.js calls .trim() on the result.  Wrap
      // these methods so they always return a string to prevent the
      // "Cannot read property 'trim' of undefined" crash.
      const _getShaderInfoLog = gl.getShaderInfoLog.bind(gl);
      gl.getShaderInfoLog = (shader) => _getShaderInfoLog(shader) || '';

      const _getProgramInfoLog = gl.getProgramInfoLog.bind(gl);
      gl.getProgramInfoLog = (program) => _getProgramInfoLog(program) || '';

      glRef.current = gl;

      const scene = new THREE.Scene();
      sceneRef.current = scene;

      const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
      const camera = new THREE.PerspectiveCamera(60, aspect, 0.01, 1000);
      camera.position.set(0, 0, 0);
      camera.lookAt(0, 0, -2.5);
      cameraRef.current = camera;

      console.log('AR: Camera initialized at (0, 0, 0) with device-motion tracking, aspect=', aspect.toFixed(2));

      const renderer = new Renderer({ gl, alpha: true });
      renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
      renderer.setPixelRatio(1);
      renderer.setClearColor(0x000000, 0);
      renderer.sortObjects = true;
      rendererRef.current = renderer;

      console.log('AR: Renderer initialized, drawingBuffer:', gl.drawingBufferWidth, 'x', gl.drawingBufferHeight);

      const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
      scene.add(ambientLight);

      const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
      dirLight.position.set(2, 5, 3);
      scene.add(dirLight);

      const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
      fillLight.position.set(-3, 2, -2);
      scene.add(fillLight);

      try {
        await loadModel();
      } catch (err) {
        console.error('Model loading failed:', err);
      }

      // Simulated surface detection delay
      setTimeout(() => {
        if (!mountedRef.current) return;

        const grid = createSurfaceGrid();
        grid.position.copy(placementPosRef.current);
        scene.add(grid);
        surfaceGridRef.current = grid;

        const reticle = createReticle();
        reticle.position.copy(placementPosRef.current);
        scene.add(reticle);
        reticleRef.current = reticle;

        surfaceDetectedRef.current = true;

        if (modelLoadedRef.current && mountedRef.current) {
          console.log('AR: STATE TRANSITION -> READY (surface detected, model already loaded)');
          setArState(AR_STATE.READY);
          setStatusMessage('Tap to place model');
        } else if (mountedRef.current) {
          console.log('AR: Surface detected but model still loading...');
          setStatusMessage('Surface found! Loading model...');
        }
      }, 2000);

      // Convert DeviceMotion rotation (alpha/beta/gamma) to camera quaternion.
      // Simplified yaw+pitch approach avoids W3C/expo-sensors axis convention issues.
      const _yawQuat = new THREE.Quaternion();
      const _pitchQuat = new THREE.Quaternion();
      const _yAxis = new THREE.Vector3(0, 1, 0);
      const _xAxis = new THREE.Vector3(1, 0, 0);

      function deviceRotationToQuaternion(alpha, beta, gamma) {
        _yawQuat.setFromAxisAngle(_yAxis, -alpha);
        const pitch = -(beta - Math.PI / 2);
        _pitchQuat.setFromAxisAngle(_xAxis, pitch);
        const q = new THREE.Quaternion();
        q.copy(_yawQuat);
        q.multiply(_pitchQuat);
        return q;
      }

      let frameCount = 0;
      const _camDir = new THREE.Vector3();
      const _reticleTarget = new THREE.Vector3();

      const render = () => {
        if (!mountedRef.current) return;
        animFrameRef.current = requestAnimationFrame(render);

        frameCount++;

        const orient = deviceOrientationRef.current;
        if (orient) {
          const q = deviceRotationToQuaternion(
            orient.alpha,
            orient.beta,
            orient.gamma
          );
          camera.quaternion.copy(q);
        }
        // Keep reticle and grid 2.5m in front of camera direction
        if (!modelPlacedRef.current) {
          camera.getWorldDirection(_camDir);
          _reticleTarget.copy(camera.position).addScaledVector(_camDir, 2.5);

          if (reticleRef.current && reticleRef.current.visible) {
            reticleRef.current.position.copy(_reticleTarget);
            reticleAnimRef.current += 0.02;
            const s = 1.0 + 0.1 * Math.sin(reticleAnimRef.current);
            reticleRef.current.scale.set(s, s, s);
            reticleRef.current.rotation.y += 0.005;
          }

          if (surfaceGridRef.current && surfaceGridRef.current.visible) {
            surfaceGridRef.current.position.copy(_reticleTarget);
          }
        }

        if (placedModelRef.current && modelPlacedRef.current) {
          const floatOffset = Math.sin(Date.now() * 0.001) * 0.005;
          placedModelRef.current.position.y =
            placementPosRef.current.y + floatOffset;
        }

        try {
          renderer.render(scene, camera);
        } catch (renderErr) {
          // Gracefully handle render errors (e.g. shader compilation
          // issues) so the animation loop doesn't crash the entire app.
          console.warn('AR render error:', renderErr);
        }
        gl.endFrameEXP();
      };

      console.log('AR: Starting render loop with device-motion camera tracking');
      render();
    },
    [object]
  );

  const loadModel = async () => {
    try {
      if (!object || !object.modelUrl) {
        throw new Error('No model URL available for this object');
      }

      const modelUrl = apiService.getFullUrl(object.modelUrl);
      if (!modelUrl) {
        throw new Error('Failed to generate model URL');
      }

      if (mountedRef.current) {
        setStatusMessage('Downloading model...');
      }
      console.log('AR: Downloading model from:', modelUrl);

      const modelPath =
        FileSystem.cacheDirectory + `ar_model_${object.id || 'temp'}.glb`;

      const downloadResult = await FileSystem.downloadAsync(modelUrl, modelPath);
      console.log('AR: Model downloaded to:', downloadResult.uri);

      if (!mountedRef.current) return;
      setStatusMessage('Detecting surfaces...');

      const base64 = await FileSystem.readAsStringAsync(downloadResult.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      if (!mountedRef.current) return;

      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      console.log('AR: Parsing GLB, buffer size:', bytes.buffer.byteLength);
      const { gltfJson, binaryData } = parseGLB(bytes.buffer);

      console.log('AR: GLB parsed -',
        'meshes:', gltfJson.meshes ? gltfJson.meshes.length : 0,
        'nodes:', gltfJson.nodes ? gltfJson.nodes.length : 0);

      if (!mountedRef.current) return;

      const group = buildSceneFromGLTF(gltfJson, binaryData);

      let meshCount = 0;
      let vertexCount = 0;
      group.traverse((child) => {
        if (child.isMesh) {
          meshCount++;
          if (child.geometry && child.geometry.attributes.position) {
            vertexCount += child.geometry.attributes.position.count;
          }
        }
      });
      console.log('AR: Built scene graph -', meshCount, 'meshes,', vertexCount, 'total vertices');

      if (meshCount === 0) {
        throw new Error('GLB parsing produced no renderable meshes');
      }

      const box = new THREE.Box3().setFromObject(group);
      const size = new THREE.Vector3();
      box.getSize(size);
      console.log('AR: Model original dimensions:', size.x.toFixed(3), 'x', size.y.toFixed(3), 'x', size.z.toFixed(3));

      if (mountedRef.current) {
        setModelDimensions({
          width: size.x.toFixed(3),
          height: size.y.toFixed(3),
          depth: size.z.toFixed(3),
        });
      }

      normalizeModel(group, 1.5);

      // Disable frustum culling to prevent incorrect culling when first placed
      group.traverse((child) => {
        if (child.isMesh) {
          child.frustumCulled = false;
        }
      });

      modelGroupRef.current = group;
      modelLoadedRef.current = true;

      console.log('AR: Model loaded and ready for placement');

      if (surfaceDetectedRef.current && mountedRef.current) {
        console.log('AR: STATE TRANSITION -> READY (model loaded, surface already detected)');
        setArState(AR_STATE.READY);
        setStatusMessage('Tap to place model');
      } else if (mountedRef.current) {
        console.log('AR: STATE TRANSITION -> DETECTING (model loaded, waiting for surface)');
        setStatusMessage('Detecting surfaces...');
        setArState(AR_STATE.DETECTING);
      }
    } catch (error) {
      console.error('AR: Error loading model:', error);
      if (mountedRef.current) {
        setArState(AR_STATE.ERROR);
        setStatusMessage('Failed to load model: ' + error.message);
      }
    }
  };

  const handleMoveLeft = useCallback(() => {
    if (!placedModelRef.current) return;
    const step = 0.1; // 10cm per tap
    modelPositionRef.current.x -= step;
    placedModelRef.current.position.x =
      placementPosRef.current.x + modelPositionRef.current.x;
    if (shadowDiscRef.current) {
      shadowDiscRef.current.position.x = placedModelRef.current.position.x;
    }
  }, []);

  const handleMoveRight = useCallback(() => {
    if (!placedModelRef.current) return;
    const step = 0.1;
    modelPositionRef.current.x += step;
    placedModelRef.current.position.x =
      placementPosRef.current.x + modelPositionRef.current.x;
    if (shadowDiscRef.current) {
      shadowDiscRef.current.position.x = placedModelRef.current.position.x;
    }
  }, []);

  const handleMoveForward = useCallback(() => {
    if (!placedModelRef.current) return;
    const step = 0.1;
    modelPositionRef.current.z -= step;
    placedModelRef.current.position.z =
      placementPosRef.current.z + modelPositionRef.current.z;
    if (shadowDiscRef.current) {
      shadowDiscRef.current.position.z = placedModelRef.current.position.z;
    }
  }, []);

  const handleMoveBack = useCallback(() => {
    if (!placedModelRef.current) return;
    const step = 0.1;
    modelPositionRef.current.z += step;
    placedModelRef.current.position.z =
      placementPosRef.current.z + modelPositionRef.current.z;
    if (shadowDiscRef.current) {
      shadowDiscRef.current.position.z = placedModelRef.current.position.z;
    }
  }, []);

  if (!cameraPermission?.granted) {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.permissionTitle}>Camera Access Required</Text>
        <Text style={styles.permissionText}>
          AR mode needs camera access to overlay 3D models on the real world.
        </Text>
        <TouchableOpacity
          style={styles.permissionButton}
          onPress={requestCameraPermission}
        >
          <Text style={styles.permissionButtonText}>Grant Permission</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.permissionBackButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.permissionBackText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View
        ref={captureViewRef}
        collapsable={false}
        style={StyleSheet.absoluteFill}
      >
        <CameraView ref={cameraNativeRef} style={StyleSheet.absoluteFill} facing="back" />

        {/* GLView in a static parent to prevent context loss on state transitions */}
        <View style={StyleSheet.absoluteFill}>
          <GLView
            ref={glViewRef}
            style={StyleSheet.absoluteFill}
            onContextCreate={onContextCreate}
          />
        </View>

        {arState === AR_STATE.PLACED && (
          <View
            style={StyleSheet.absoluteFill}
            {...panResponder.panHandlers}
          />
        )}

        {arState === AR_STATE.READY && (
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={handleTapToPlace}
          />
        )}
      </View>

      {/* Hidden compositing view for screenshot capture */}
      {compositePhotos && (
        <View
          ref={compositeViewRef}
          collapsable={false}
          style={styles.compositeContainer}
        >
          <Image
            source={{ uri: compositePhotos.cameraUri }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
          <Image
            source={{ uri: compositePhotos.glUri }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
        </View>
      )}

      {uiVisible && (
        <>
          <View style={styles.topBar}>
            <TouchableOpacity
              style={styles.topButton}
              onPress={() => navigation.goBack()}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={styles.topButtonText}>X</Text>
            </TouchableOpacity>

            <View style={styles.topTitleContainer}>
              <Text style={styles.topTitle} numberOfLines={1}>
                {object.name || 'AR View'}
              </Text>
              {arState === AR_STATE.PLACED && modelDimensions && (
                <Text style={styles.topSubtitle}>
                  {modelDimensions.width}m x {modelDimensions.height}m x{' '}
                  {modelDimensions.depth}m
                </Text>
              )}
            </View>

            <TouchableOpacity
              style={[
                styles.topButton,
                arState !== AR_STATE.PLACED && styles.topButtonDisabled,
              ]}
              onPress={handleReset}
              disabled={arState !== AR_STATE.PLACED}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text
                style={[
                  styles.topButtonText,
                  arState !== AR_STATE.PLACED && styles.topButtonTextDisabled,
                ]}
              >
                Reset
              </Text>
            </TouchableOpacity>
          </View>

          {arState !== AR_STATE.PLACED && (
            <View style={styles.statusContainer}>
              {arState === AR_STATE.LOADING && (
                <View style={styles.statusRow}>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.statusText}>{statusMessage}</Text>
                </View>
              )}

              {arState === AR_STATE.DETECTING && (
                <View style={styles.statusRow}>
                  <ActivityIndicator size="small" color="#00ff88" />
                  <Text style={styles.statusText}>{statusMessage}</Text>
                </View>
              )}

              {arState === AR_STATE.READY && (
                <Animated.View
                  style={[
                    styles.statusRow,
                    styles.statusReady,
                    { transform: [{ scale: pulseAnim }] },
                  ]}
                >
                  <Text style={styles.statusTextReady}>{statusMessage}</Text>
                </Animated.View>
              )}

              {arState === AR_STATE.ERROR && (
                <View style={[styles.statusRow, styles.statusError]}>
                  <Text style={styles.statusTextError}>{statusMessage}</Text>
                </View>
              )}
            </View>
          )}

          {(arState === AR_STATE.DETECTING || arState === AR_STATE.READY) && (
            <View style={styles.reticleOverlay} pointerEvents="none">
              <Animated.View
                style={[
                  styles.reticleIndicator,
                  arState === AR_STATE.READY && styles.reticleIndicatorActive,
                  { transform: [{ scale: pulseAnim }] },
                ]}
              >
                <View style={styles.reticleInner} />
                <View style={[styles.reticleLine, styles.reticleLineH]} />
                <View style={[styles.reticleLine, styles.reticleLineV]} />
              </Animated.View>
            </View>
          )}

          {arState === AR_STATE.PLACED && (
            <View style={styles.bottomControls}>
              <View style={styles.positionControls}>
                <View style={styles.positionRow}>
                  <View style={styles.positionSpacer} />
                  <TouchableOpacity
                    style={styles.positionButton}
                    onPress={handleMoveForward}
                  >
                    <Text style={styles.positionButtonText}>↑</Text>
                  </TouchableOpacity>
                  <View style={styles.positionSpacer} />
                </View>
                <View style={styles.positionRow}>
                  <TouchableOpacity
                    style={styles.positionButton}
                    onPress={handleMoveLeft}
                  >
                    <Text style={styles.positionButtonText}>←</Text>
                  </TouchableOpacity>
                  <View style={styles.positionCenter}>
                    <Text style={styles.positionLabel}>Move</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.positionButton}
                    onPress={handleMoveRight}
                  >
                    <Text style={styles.positionButtonText}>→</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.positionRow}>
                  <View style={styles.positionSpacer} />
                  <TouchableOpacity
                    style={styles.positionButton}
                    onPress={handleMoveBack}
                  >
                    <Text style={styles.positionButtonText}>↓</Text>
                  </TouchableOpacity>
                  <View style={styles.positionSpacer} />
                </View>
              </View>

              <View style={styles.captureRow}>
                <TouchableOpacity
                  style={styles.captureButton}
                  onPress={handleCapture}
                >
                  <View style={styles.captureButtonInner} />
                </TouchableOpacity>
              </View>

              <Text style={styles.hintText}>
                Drag to rotate • Pinch to scale • Arrows to move
              </Text>
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },

  compositeContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    zIndex: -1,
    overflow: 'hidden',
  },

  permissionContainer: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  permissionTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 12,
    textAlign: 'center',
  },
  permissionText: {
    fontSize: 15,
    color: '#aaa',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 30,
  },
  permissionButton: {
    backgroundColor: '#00ff88',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
    marginBottom: 16,
  },
  permissionButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a1a2e',
  },
  permissionBackButton: {
    paddingVertical: 10,
  },
  permissionBackText: {
    fontSize: 15,
    color: '#aaa',
  },

  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: Platform.OS === 'ios' ? 54 : 36,
    paddingBottom: 12,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  topButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 50,
    alignItems: 'center',
  },
  topButtonDisabled: {
    opacity: 0.4,
  },
  topButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  topButtonTextDisabled: {
    color: '#888',
  },
  topTitleContainer: {
    flex: 1,
    alignItems: 'center',
    marginHorizontal: 12,
  },
  topTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  topSubtitle: {
    color: '#00ff88',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 2,
  },

  statusContainer: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 110 : 90,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    gap: 8,
  },
  statusReady: {
    backgroundColor: 'rgba(0, 255, 136, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(0, 255, 136, 0.5)',
  },
  statusError: {
    backgroundColor: 'rgba(255, 59, 48, 0.3)',
    borderWidth: 1,
    borderColor: 'rgba(255, 59, 48, 0.5)',
  },
  statusText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  statusTextReady: {
    color: '#00ff88',
    fontSize: 15,
    fontWeight: '600',
  },
  statusTextError: {
    color: '#ff6b6b',
    fontSize: 14,
    fontWeight: '500',
  },

  reticleOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  reticleIndicator: {
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  reticleIndicatorActive: {
    borderColor: 'rgba(0, 255, 136, 0.6)',
  },
  reticleInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(0, 255, 136, 0.8)',
  },
  reticleLine: {
    position: 'absolute',
    backgroundColor: 'rgba(0, 255, 136, 0.4)',
  },
  reticleLineH: {
    width: 30,
    height: 1,
  },
  reticleLineV: {
    width: 1,
    height: 30,
  },

  bottomControls: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    paddingTop: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },

  positionControls: {
    marginBottom: 12,
  },
  positionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 2,
  },
  positionButton: {
    width: 50,
    height: 50,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 4,
  },
  positionButtonText: {
    fontSize: 24,
    color: '#fff',
    fontWeight: '600',
  },
  positionCenter: {
    width: 50,
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
  },
  positionLabel: {
    fontSize: 12,
    color: '#fff',
    fontWeight: '600',
  },
  positionSpacer: {
    width: 50,
    marginHorizontal: 4,
  },

  captureRow: {
    alignItems: 'center',
    marginBottom: 8,
  },
  captureButton: {
    width: 70,
    height: 70,
    borderRadius: 35,
    borderWidth: 4,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  captureButtonInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#fff',
  },

  hintText: {
    textAlign: 'center',
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 12,
    paddingHorizontal: 20,
  },

  errorText: {
    fontSize: 18,
    color: '#fff',
    textAlign: 'center',
    marginBottom: 20,
  },
});
