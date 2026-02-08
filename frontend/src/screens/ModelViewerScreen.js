// IMPORTANT: Import polyfill patch BEFORE expo-three to fix
// "document.getElementById(id)?.remove is not a function" error
import '../utils/patchBrowserPolyfill';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Text,
  ActivityIndicator,
  Alert,
  PanResponder,
  Dimensions,
} from 'react-native';
import { GLView } from 'expo-gl';
import * as THREE from 'three';
import { Renderer } from 'expo-three';
import * as FileSystem from 'expo-file-system/legacy';
import apiService from '../services/api';

// GLB binary parser (works without DOM APIs, no GLTFLoader needed)
const GLB_MAGIC = 0x46546C67; // 'glTF' in little-endian
const CHUNK_TYPE_JSON = 0x4E4F534A;
const CHUNK_TYPE_BIN = 0x004E4942;

/**
 * Component type to TypedArray constructor and byte size.
 */
const COMPONENT_TYPES = {
  5120: { array: Int8Array, size: 1 },
  5121: { array: Uint8Array, size: 1 },
  5122: { array: Int16Array, size: 2 },
  5123: { array: Uint16Array, size: 2 },
  5125: { array: Uint32Array, size: 4 },
  5126: { array: Float32Array, size: 4 },
};

/**
 * Number of components per element for each accessor type.
 */
const TYPE_SIZES = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

/**
 * Read accessor data from the binary buffer, respecting bufferView
 * byteOffset, byteStride, and accessor byteOffset.
 */
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

  // If there is no interleaving (byteStride is 0 or equals tightly packed
  // size), we can create a single typed-array view directly.
  const tightStride = componentInfo.size * numComponents;

  if (byteStride === 0 || byteStride === tightStride) {
    // Fast path - contiguous data
    const totalElements = count * numComponents;
    return new componentInfo.array(
      binaryData.buffer,
      binaryData.byteOffset + byteOffset,
      totalElements
    );
  }

  // Slow path - interleaved data, must copy element by element
  const result = new componentInfo.array(count * numComponents);
  const dataView = new DataView(
    binaryData.buffer,
    binaryData.byteOffset
  );

  for (let i = 0; i < count; i++) {
    const elementOffset = byteOffset + i * byteStride;
    for (let j = 0; j < numComponents; j++) {
      const compOffset = elementOffset + j * componentInfo.size;
      switch (accessor.componentType) {
        case 5126: // FLOAT
          result[i * numComponents + j] = dataView.getFloat32(
            compOffset,
            true
          );
          break;
        case 5123: // UNSIGNED_SHORT
          result[i * numComponents + j] = dataView.getUint16(
            compOffset,
            true
          );
          break;
        case 5125: // UNSIGNED_INT
          result[i * numComponents + j] = dataView.getUint32(
            compOffset,
            true
          );
          break;
        case 5121: // UNSIGNED_BYTE
          result[i * numComponents + j] = dataView.getUint8(compOffset);
          break;
        case 5122: // SHORT
          result[i * numComponents + j] = dataView.getInt16(
            compOffset,
            true
          );
          break;
        case 5120: // BYTE
          result[i * numComponents + j] = dataView.getInt8(compOffset);
          break;
      }
    }
  }
  return result;
}

/**
 * Parse a GLB ArrayBuffer and return { gltfJson, binaryData }.
 */
function parseGLB(arrayBuffer) {
  const dataView = new DataView(arrayBuffer);

  // Header (12 bytes)
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

  // Read chunks
  while (offset < totalLength) {
    const chunkLength = dataView.getUint32(offset, true);
    const chunkType = dataView.getUint32(offset + 4, true);

    if (chunkType === CHUNK_TYPE_JSON) {
      const jsonBytes = new Uint8Array(arrayBuffer, offset + 8, chunkLength);
      // Manual UTF-8 decode without TextDecoder for maximum compatibility
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

/**
 * Build a THREE.Group from parsed GLB data by iterating all meshes and
 * primitives. Handles positions, normals, UVs, vertex colors, and indices.
 * Materials are approximated using MeshStandardMaterial.
 */
function buildSceneFromGLTF(gltfJson, binaryData) {
  const group = new THREE.Group();

  if (!gltfJson.meshes || gltfJson.meshes.length === 0) {
    throw new Error('GLB contains no meshes');
  }

  // Process nodes to apply transforms, or fall back to raw meshes
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

/**
 * Recursively process a glTF node and its children.
 */
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

  // Apply transform
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

  // Process children
  if (node.children) {
    for (const childIndex of node.children) {
      const child = processNode(gltfJson, binaryData, childIndex);
      if (child) obj.add(child);
    }
  }

  return obj;
}

/**
 * Build a single THREE.Mesh from a glTF primitive.
 */
function buildPrimitive(gltfJson, binaryData, primitive) {
  if (!binaryData) {
    throw new Error('GLB has no binary data chunk');
  }

  const geometry = new THREE.BufferGeometry();

  // Positions (required)
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

  // Normals
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

  // UVs
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

  // Vertex colors
  if (primitive.attributes.COLOR_0 !== undefined) {
    const colors = readAccessor(
      gltfJson,
      binaryData,
      primitive.attributes.COLOR_0
    );
    const accessor = gltfJson.accessors[primitive.attributes.COLOR_0];
    const numComponents = TYPE_SIZES[accessor.type];

    // Normalize if integer type
    let colorArray;
    if (accessor.componentType === 5121) {
      // UNSIGNED_BYTE -> normalize to 0-1
      colorArray = new Float32Array(colors.length);
      for (let i = 0; i < colors.length; i++) {
        colorArray[i] = colors[i] / 255;
      }
    } else if (accessor.componentType === 5123) {
      // UNSIGNED_SHORT -> normalize to 0-1
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

  // Indices
  if (primitive.indices !== undefined) {
    const indices = readAccessor(
      gltfJson,
      binaryData,
      primitive.indices
    );
    const accessor = gltfJson.accessors[primitive.indices];
    // Choose the right typed array for the index buffer
    let indexArray;
    if (accessor.componentType === 5125) {
      indexArray = new Uint32Array(indices);
    } else if (accessor.componentType === 5123) {
      indexArray = new Uint16Array(indices);
    } else {
      indexArray = new Uint16Array(indices);
    }
    geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
  }

  // Compute normals if not provided
  if (primitive.attributes.NORMAL === undefined) {
    geometry.computeVertexNormals();
  }

  // Build material
  const material = buildMaterial(gltfJson, primitive);

  return new THREE.Mesh(geometry, material);
}

/**
 * Create a THREE.MeshStandardMaterial from glTF material definition.
 * Since we can't load textures via GLTFLoader in RN, we only extract
 * base color factor, metallic, roughness, and emissive.
 */
function buildMaterial(gltfJson, primitive) {
  const materialProps = {
    metalness: 0.1,
    roughness: 0.8,
    side: THREE.DoubleSide,
  };

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

      if (pbr.metallicFactor !== undefined) {
        materialProps.metalness = pbr.metallicFactor;
      }
      if (pbr.roughnessFactor !== undefined) {
        materialProps.roughness = pbr.roughnessFactor;
      }
    }

    if (mat.emissiveFactor) {
      materialProps.emissive = new THREE.Color(...mat.emissiveFactor);
    }

    if (mat.doubleSided === false) {
      materialProps.side = THREE.FrontSide;
    }
  }

  // If vertex colors exist, enable them
  const hasVertexColors =
    primitive.attributes.COLOR_0 !== undefined;
  if (hasVertexColors) {
    materialProps.vertexColors = true;
  }

  // Default color if none specified and no vertex colors
  if (!materialProps.color && !hasVertexColors) {
    materialProps.color = new THREE.Color(0x8899aa);
  }

  return new THREE.MeshStandardMaterial(materialProps);
}

/**
 * Center and scale a group so it fits in a unit sphere of given radius.
 */
function normalizeModel(group, targetSize = 2.0) {
  const box = new THREE.Box3().setFromObject(group);
  const center = new THREE.Vector3();
  box.getCenter(center);

  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);

  if (maxDim === 0) return;

  const scale = targetSize / maxDim;
  group.scale.multiplyScalar(scale);

  // Re-center after scaling
  const scaledBox = new THREE.Box3().setFromObject(group);
  const scaledCenter = new THREE.Vector3();
  scaledBox.getCenter(scaledCenter);
  group.position.sub(scaledCenter);
}

function createGrid(size = 4, divisions = 10) {
  const gridHelper = new THREE.GridHelper(size, divisions, 0xcccccc, 0xe0e0e0);
  gridHelper.position.y = -1.1;
  return gridHelper;
}

export default function ModelViewerScreen({ route, navigation }) {
  const { object } = route.params;

  const [status, setStatus] = useState('loading'); // 'loading' | 'loaded' | 'error'
  const [errorMsg, setErrorMsg] = useState('');
  const [loadProgress, setLoadProgress] = useState('Initializing...');
  const [modelDimensions, setModelDimensions] = useState(null);

  const modelRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const glRef = useRef(null);
  const animFrameRef = useRef(null);
  const mountedRef = useRef(true);

  // Touch control state
  const rotationRef = useRef({ x: 0.3, y: 0 });
  const autoRotateRef = useRef(true);
  const zoomRef = useRef(3.0);
  const lastTouchRef = useRef(null);
  const lastPinchDistRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,

      onPanResponderGrant: (evt) => {
        autoRotateRef.current = false;
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
        const touches = evt.nativeEvent.touches;
        if (touches.length === 1 && lastTouchRef.current) {
          // Rotate
          const dx = touches[0].pageX - lastTouchRef.current.x;
          const dy = touches[0].pageY - lastTouchRef.current.y;
          rotationRef.current = {
            x: rotationRef.current.x + dy * 0.005,
            y: rotationRef.current.y + dx * 0.005,
          };
          lastTouchRef.current = {
            x: touches[0].pageX,
            y: touches[0].pageY,
          };
        } else if (touches.length === 2) {
          // Pinch zoom
          const dx = touches[0].pageX - touches[1].pageX;
          const dy = touches[0].pageY - touches[1].pageY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (lastPinchDistRef.current !== null) {
            const scaleFactor = lastPinchDistRef.current / dist;
            zoomRef.current = Math.max(
              1.5,
              Math.min(10.0, zoomRef.current * scaleFactor)
            );
          }
          lastPinchDistRef.current = dist;
          lastTouchRef.current = null;
        }
      },

      onPanResponderRelease: () => {
        lastTouchRef.current = null;
        lastPinchDistRef.current = null;
        // Re-enable auto-rotate after a delay
        setTimeout(() => {
          if (mountedRef.current) {
            autoRotateRef.current = true;
          }
        }, 3000);
      },
    })
  ).current;

  const onContextCreate = useCallback(
    async (gl) => {
      if (!mountedRef.current) return;
      glRef.current = gl;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xf0f2f5);
      sceneRef.current = scene;

      const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
      const camera = new THREE.PerspectiveCamera(50, aspect, 0.01, 1000);
      camera.position.set(0, 1, zoomRef.current);
      camera.lookAt(0, 0, 0);
      cameraRef.current = camera;

      const renderer = new Renderer({ gl });
      renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
      renderer.setPixelRatio(1);
      rendererRef.current = renderer;

      const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
      scene.add(ambientLight);

      const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.9);
      dirLight1.position.set(5, 8, 5);
      scene.add(dirLight1);

      const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
      dirLight2.position.set(-5, 3, -5);
      scene.add(dirLight2);

      const dirLight3 = new THREE.DirectionalLight(0xffffff, 0.3);
      dirLight3.position.set(0, -3, 5);
      scene.add(dirLight3);

      scene.add(createGrid());

      try {
        await loadModel(scene);
      } catch (err) {
        console.error('Model loading failed in onContextCreate:', err);
      }

      const render = () => {
        if (!mountedRef.current) return;
        animFrameRef.current = requestAnimationFrame(render);

        if (autoRotateRef.current && modelRef.current) {
          rotationRef.current = {
            ...rotationRef.current,
            y: rotationRef.current.y + 0.008,
          };
        }

        if (modelRef.current) {
          modelRef.current.rotation.x = rotationRef.current.x;
          modelRef.current.rotation.y = rotationRef.current.y;
        }

        if (cameraRef.current) {
          const cam = cameraRef.current;
          const targetZ = zoomRef.current;
          cam.position.z += (targetZ - cam.position.z) * 0.1;
        }

        renderer.render(scene, camera);
        gl.endFrameEXP();
      };

      render();
    },
    [object]
  );

  const loadModel = async (scene) => {
    try {
      const modelUrl = apiService.getFullUrl(object.modelUrl);
      if (!modelUrl) {
        throw new Error('No model URL available for this object');
      }

      if (mountedRef.current) {
        setLoadProgress('Downloading model...');
      }
      console.log('Downloading model from:', modelUrl);

      const modelPath =
        FileSystem.cacheDirectory + `model_${object.id || 'temp'}.glb`;

      const downloadResult = await FileSystem.downloadAsync(
        modelUrl,
        modelPath
      );
      console.log('Model downloaded to:', downloadResult.uri);

      if (!mountedRef.current) return;
      setLoadProgress('Reading model data...');

      const base64 = await FileSystem.readAsStringAsync(downloadResult.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      if (!mountedRef.current) return;
      setLoadProgress('Parsing 3D model...');

      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const { gltfJson, binaryData } = parseGLB(bytes.buffer);

      if (!mountedRef.current) return;
      setLoadProgress('Building 3D scene...');

      const group = buildSceneFromGLTF(gltfJson, binaryData);

      const box = new THREE.Box3().setFromObject(group);
      const size = new THREE.Vector3();
      box.getSize(size);

      if (mountedRef.current) {
        setModelDimensions({
          width: size.x.toFixed(2),
          height: size.y.toFixed(2),
          depth: size.z.toFixed(2),
        });
      }

      normalizeModel(group, 2.0);

      scene.add(group);
      modelRef.current = group;

      if (mountedRef.current) {
        setStatus('loaded');
      }

      console.log('Model loaded and displayed successfully');
    } catch (error) {
      console.error('Error loading model:', error);
      if (mountedRef.current) {
        setStatus('error');
        setErrorMsg(error.message || 'Failed to load 3D model');
      }
    }
  };

  const handleRetry = useCallback(() => {
    setStatus('loading');
    setErrorMsg('');
    setLoadProgress('Retrying...');

    if (sceneRef.current && modelRef.current) {
      sceneRef.current.remove(modelRef.current);
      modelRef.current = null;
    }

    if (sceneRef.current) {
      loadModel(sceneRef.current);
    }
  }, [object]);

  const handleResetView = useCallback(() => {
    rotationRef.current = { x: 0.3, y: 0 };
    zoomRef.current = 3.0;
    autoRotateRef.current = true;
  }, []);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {object.name || '3D Model'}
        </Text>
        <TouchableOpacity
          onPress={handleResetView}
          style={styles.resetButton}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.resetButtonText}>Reset</Text>
        </TouchableOpacity>
      </View>

      {/* 3D Viewer */}
      <View style={styles.viewerContainer} {...panResponder.panHandlers}>
        <GLView
          style={styles.glView}
          onContextCreate={onContextCreate}
          msaaSamples={4}
        />

        {/* Loading overlay */}
        {status === 'loading' && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.loadingText}>{loadProgress}</Text>
          </View>
        )}

        {/* Error overlay */}
        {status === 'error' && (
          <View style={styles.errorOverlay}>
            <Text style={styles.errorIcon}>!</Text>
            <Text style={styles.errorTitle}>Failed to Load Model</Text>
            <Text style={styles.errorMessage}>{errorMsg}</Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={handleRetry}
            >
              <Text style={styles.retryButtonText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Footer with controls hint */}
      <View style={styles.footer}>
        {status === 'loaded' && modelDimensions && (
          <>
            <Text style={styles.dimensionsText}>
              Actual Size: {modelDimensions.width}m × {modelDimensions.height}m × {modelDimensions.depth}m (W×H×D)
            </Text>
            <Text style={styles.hint}>
              Drag to rotate | Pinch to zoom | Auto-rotates after 3s
            </Text>
          </>
        )}
        {status === 'loaded' && !modelDimensions && (
          <Text style={styles.hint}>
            Drag to rotate | Pinch to zoom | Auto-rotates after 3s
          </Text>
        )}
        {status === 'loading' && (
          <Text style={styles.hint}>Preparing 3D viewer...</Text>
        )}
        {status === 'error' && (
          <Text style={[styles.hint, { color: '#FF3B30' }]}>
            Check your connection and try again
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 54,
    paddingBottom: 12,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#d0d0d0',
  },
  backButton: {
    paddingVertical: 6,
    paddingHorizontal: 4,
    minWidth: 50,
  },
  backButtonText: {
    color: '#007AFF',
    fontSize: 17,
    fontWeight: '600',
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: '#1a1a1a',
    textAlign: 'center',
    marginHorizontal: 8,
  },
  resetButton: {
    paddingVertical: 6,
    paddingHorizontal: 4,
    minWidth: 50,
    alignItems: 'flex-end',
  },
  resetButtonText: {
    color: '#007AFF',
    fontSize: 15,
    fontWeight: '500',
  },
  viewerContainer: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#f0f2f5',
  },
  glView: {
    flex: 1,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(240, 242, 245, 0.95)',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: '#555',
    fontWeight: '500',
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(240, 242, 245, 0.97)',
    paddingHorizontal: 40,
  },
  errorIcon: {
    fontSize: 40,
    fontWeight: 'bold',
    color: '#FF3B30',
    marginBottom: 12,
    width: 60,
    height: 60,
    lineHeight: 60,
    textAlign: 'center',
    borderRadius: 30,
    borderWidth: 3,
    borderColor: '#FF3B30',
    overflow: 'hidden',
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 8,
  },
  errorMessage: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  retryButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  footer: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: '#f8f9fa',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#d0d0d0',
    alignItems: 'center',
  },
  hint: {
    fontSize: 13,
    color: '#888',
    textAlign: 'center',
  },
  dimensionsText: {
    fontSize: 14,
    color: '#007AFF',
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 4,
  },
});
