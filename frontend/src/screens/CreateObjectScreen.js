import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Image,
  Alert,
  ActivityIndicator,
  Animated,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import apiService from '../services/api';

const GENERATION_MESSAGES = [
  'Uploading images...',
  'Starting 3D reconstruction...',
  'Analyzing object geometry...',
  'Building 3D mesh...',
  'Generating textures...',
  'Refining details...',
  'Finalizing model...',
];

export default function CreateObjectScreen({ navigation }) {
  const [name, setName] = useState('');
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('');
  const [generationProgress, setGenerationProgress] = useState(0);
  const [generationMethod, setGenerationMethod] = useState('');
  const progressAnim = useRef(new Animated.Value(0)).current;

  const pickImage = async () => {
    if (images.length >= 4) {
      Alert.alert('Limit Reached', 'You can only upload up to 4 images');
      return;
    }

    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Denied', 'Camera roll permission is required');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.8,
    });

    if (!result.canceled) {
      setImages([...images, result.assets[0]]);
    }
  };

  const takePhoto = async () => {
    if (images.length >= 4) {
      Alert.alert('Limit Reached', 'You can only upload up to 4 images');
      return;
    }

    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Denied', 'Camera permission is required');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      quality: 0.8,
    });

    if (!result.canceled) {
      setImages([...images, result.assets[0]]);
    }
  };

  const removeImage = (index) => {
    setImages(images.filter((_, i) => i !== index));
  };

  const updateProgress = (progress, status) => {
    setGenerationProgress(progress);
    setGenerationStatus(status);

    Animated.timing(progressAnim, {
      toValue: progress / 100,
      duration: 500,
      useNativeDriver: false,
    }).start();
  };

  const getStatusMessage = () => {
    if (generationProgress < 10) return GENERATION_MESSAGES[0];
    if (generationProgress < 20) return GENERATION_MESSAGES[1];
    if (generationProgress < 40) return GENERATION_MESSAGES[2];
    if (generationProgress < 60) return GENERATION_MESSAGES[3];
    if (generationProgress < 75) return GENERATION_MESSAGES[4];
    if (generationProgress < 90) return GENERATION_MESSAGES[5];
    return GENERATION_MESSAGES[6];
  };

  const handleSubmit = async () => {
    // Validation
    if (!name.trim()) {
      Alert.alert('Error', 'Please enter an object name');
      return;
    }

    if (images.length === 0) {
      Alert.alert('Error', 'Please upload at least one image');
      return;
    }

    try {
      setLoading(true);
      setGenerationStatus('uploading');
      setGenerationProgress(0);
      progressAnim.setValue(0);

      const objectData = {
        name: name.trim(),
      };

      // Step 1: Create object and start async generation
      const response = await apiService.createObject(objectData, images);
      const objectId = response.object.id;

      setGenerationStatus('processing');
      setGenerationMethod(response.object.generationMethod || '');

      // Step 2: If the generation is already complete, we're done
      if (response.object.generationStatus === 'completed') {
        updateProgress(100, 'completed');
        showSuccessAlert(response.object.generationMethod);
        return;
      }

      // Step 3: Poll for completion with progress updates
      updateProgress(5, 'processing');

      const finalStatus = await apiService.waitForGeneration(
        objectId,
        (progress, status) => {
          // Ensure progress only goes forward
          const effectiveProgress = Math.max(progress, generationProgress);
          updateProgress(effectiveProgress, status);
        },
        3000,  // poll every 3 seconds
        300000 // 5 minute timeout
      );

      updateProgress(100, 'completed');
      setGenerationMethod(finalStatus.generationMethod || '');

      showSuccessAlert(finalStatus.generationMethod);

    } catch (error) {
      console.error('Error creating object:', error);

      const message = error.message || 'Failed to create object';
      if (message.includes('timed out')) {
        Alert.alert(
          'Generation Timeout',
          'The 3D model is still being generated. You can check back later in the Object Library.'
        );
      } else {
        Alert.alert(
          'Error',
          `Failed to create 3D model: ${message}`
        );
      }
    } finally {
      setLoading(false);
      setGenerationStatus('');
      setGenerationProgress(0);
      progressAnim.setValue(0);
    }
  };

  const showSuccessAlert = (method) => {
    const methodName = method === 'meshy' ? 'Meshy.ai AI' :
                       method === 'tripo' ? 'Tripo AI' :
                       'AI';

    Alert.alert(
      '3D Model Created!',
      `Your object has been reconstructed in 3D using ${methodName} reconstruction.`,
      [
        {
          text: 'View in Library',
          onPress: () => navigation.navigate('ObjectLibrary'),
        },
      ]
    );
  };

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <ScrollView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.sectionTitle}>Object Information</Text>

        <TextInput
          style={styles.input}
          placeholder="Object Name"
          value={name}
          onChangeText={setName}
          editable={!loading}
        />

        <Text style={styles.sectionTitle}>Photos ({images.length}/4)</Text>
        <Text style={styles.hint}>
          Take clear photos from different angles for best 3D reconstruction
        </Text>

        <View style={styles.imagesContainer}>
          {images.map((image, index) => (
            <View key={index} style={styles.imageWrapper}>
              <Image source={{ uri: image.uri }} style={styles.image} />
              {!loading && (
                <TouchableOpacity
                  style={styles.removeButton}
                  onPress={() => removeImage(index)}
                >
                  <Text style={styles.removeButtonText}>X</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}

          {images.length < 4 && !loading && (
            <View style={styles.addButtonsContainer}>
              <TouchableOpacity style={styles.addImageButton} onPress={pickImage}>
                <Text style={styles.addImageIcon}>+</Text>
                <Text style={styles.addImageLabel}>Gallery</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.addImageButton} onPress={takePhoto}>
                <Text style={styles.addImageIcon}>C</Text>
                <Text style={styles.addImageLabel}>Camera</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Generation progress overlay */}
        {loading && (
          <View style={styles.progressContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.progressTitle}>
              {generationStatus === 'uploading' ? 'Uploading...' : 'Generating 3D Model'}
            </Text>
            <Text style={styles.progressMessage}>
              {getStatusMessage()}
            </Text>

            {/* Progress bar */}
            <View style={styles.progressBarContainer}>
              <Animated.View
                style={[styles.progressBar, { width: progressWidth }]}
              />
            </View>
            <Text style={styles.progressPercent}>
              {Math.round(generationProgress)}%
            </Text>

            {generationMethod ? (
              <Text style={styles.methodBadge}>
                {generationMethod === 'meshy' ? 'Meshy.ai' :
                 generationMethod === 'tripo' ? 'Tripo AI' :
                 'AI'} Reconstruction
              </Text>
            ) : null}

            <Text style={styles.progressHint}>
              AI 3D reconstruction may take 1-3 minutes.{'\n'}
              Please keep this screen open.
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.submitButton, loading && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={loading}
        >
          {loading ? (
            <Text style={styles.submitButtonText}>Generating 3D Model...</Text>
          ) : (
            <Text style={styles.submitButtonText}>Create 3D Model</Text>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  content: {
    padding: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 10,
    color: '#333',
  },
  hint: {
    fontSize: 13,
    color: '#888',
    marginBottom: 10,
    fontStyle: 'italic',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    backgroundColor: '#fff',
  },
  imagesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  imageWrapper: {
    position: 'relative',
  },
  image: {
    width: 80,
    height: 80,
    borderRadius: 8,
  },
  removeButton: {
    position: 'absolute',
    top: -8,
    right: -8,
    backgroundColor: '#FF3B30',
    borderRadius: 12,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  addButtonsContainer: {
    flexDirection: 'row',
    gap: 10,
  },
  addImageButton: {
    width: 80,
    height: 80,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#ddd',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addImageIcon: {
    fontSize: 24,
    color: '#999',
  },
  addImageLabel: {
    fontSize: 10,
    color: '#999',
    marginTop: 2,
  },

  // Progress indicator styles
  progressContainer: {
    backgroundColor: '#F8F9FA',
    borderRadius: 12,
    padding: 24,
    marginTop: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E9ECEF',
  },
  progressTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#333',
    marginTop: 16,
    marginBottom: 4,
  },
  progressMessage: {
    fontSize: 14,
    color: '#666',
    marginBottom: 16,
    textAlign: 'center',
  },
  progressBarContainer: {
    width: '100%',
    height: 8,
    backgroundColor: '#E9ECEF',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#007AFF',
    borderRadius: 4,
  },
  progressPercent: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
    marginTop: 8,
  },
  methodBadge: {
    fontSize: 12,
    color: '#fff',
    backgroundColor: '#007AFF',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginTop: 12,
    overflow: 'hidden',
  },
  progressHint: {
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 18,
  },

  submitButton: {
    backgroundColor: '#007AFF',
    padding: 18,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 30,
    marginBottom: 40,
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
});
