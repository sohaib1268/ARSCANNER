import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  Image,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import apiService from '../services/api';

export default function ObjectLibraryScreen({ navigation }) {
  const [objects, setObjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const pollIntervalRef = useRef(null);

  useEffect(() => {
    loadObjects();

    // Start polling for any objects that are still processing
    pollIntervalRef.current = setInterval(() => {
      refreshProcessingObjects();
    }, 5000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  // Also refresh when navigating back to this screen
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      loadObjects();
    });
    return unsubscribe;
  }, [navigation]);

  const loadObjects = async () => {
    try {
      setLoading(true);
      const data = await apiService.getObjects();
      setObjects(data);
    } catch (error) {
      console.error('Error loading objects:', error);
      Alert.alert('Error', 'Failed to load objects. Make sure backend is running.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const refreshProcessingObjects = async () => {
    // Check if any objects are still processing
    const processingObjects = objects.filter(
      obj => obj.generationStatus === 'processing' || obj.generationStatus === 'pending'
    );

    if (processingObjects.length === 0) return;

    try {
      const data = await apiService.getObjects();
      setObjects(data);
    } catch (error) {
      // Silently fail - will retry on next interval
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadObjects();
  };

  const handleDelete = (objectId, objectName) => {
    Alert.alert(
      'Delete Object',
      `Are you sure you want to delete "${objectName}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await apiService.deleteObject(objectId);
              Alert.alert('Success', 'Object deleted');
              loadObjects();
            } catch (error) {
              Alert.alert('Error', 'Failed to delete object');
            }
          },
        },
      ]
    );
  };

  const handleRegenerate = async (objectId) => {
    try {
      await apiService.regenerateModel(objectId);
      Alert.alert('Regeneration Started', '3D model is being regenerated. Pull down to refresh.');
      loadObjects();
    } catch (error) {
      Alert.alert('Error', 'Failed to start regeneration');
    }
  };

  const handleViewDetails = (object) => {
    const methodName = object.generationMethod === 'meshy' ? 'Meshy.ai AI' :
                       object.generationMethod === 'tripo' ? 'Tripo AI' :
                       'AI';

    const genTime = object.generationTime
      ? `${(object.generationTime / 1000).toFixed(1)}s`
      : 'N/A';

    const details = `
Name: ${object.name}
Images: ${object.imageUrls.length} uploaded
Status: ${object.generationStatus || 'completed'}
Method: ${methodName}
Generation Time: ${genTime}
Created: ${new Date(object.createdAt).toLocaleString()}
    `.trim();

    Alert.alert('Object Details', details);
  };

  const handleView3D = (object) => {
    navigation.navigate('ModelViewer', { object });
  };

  const handleViewAR = (object) => {
    navigation.navigate('ARView', { object });
  };

  const getStatusInfo = (item) => {
    const status = item.generationStatus || 'completed';

    switch (status) {
      case 'completed':
        return {
          text: `3D Model Ready (${getMethodLabel(item.generationMethod)})`,
          color: '#34C759',
          icon: '[OK]'
        };
      case 'processing':
        return {
          text: `Generating 3D... ${item.generationProgress || 0}%`,
          color: '#FF9500',
          icon: ''
        };
      case 'pending':
        return {
          text: 'Waiting to start...',
          color: '#8E8E93',
          icon: ''
        };
      case 'failed':
        return {
          text: 'Generation failed - tap to retry',
          color: '#FF3B30',
          icon: '[!]'
        };
      default:
        return {
          text: 'Unknown status',
          color: '#8E8E93',
          icon: '?'
        };
    }
  };

  const getMethodLabel = (method) => {
    switch (method) {
      case 'meshy': return 'AI Reconstructed';
      case 'tripo': return 'AI Reconstructed';
      default: return 'AI Model';
    }
  };

  const renderItem = ({ item }) => {
    const thumbnailUrl = item.imageUrls && item.imageUrls.length > 0
      ? apiService.getFullUrl(item.imageUrls[0])
      : null;

    const statusInfo = getStatusInfo(item);
    const isProcessing = item.generationStatus === 'processing' || item.generationStatus === 'pending';
    const isFailed = item.generationStatus === 'failed';
    const isCompleted = item.generationStatus === 'completed';

    return (
      <View style={styles.card}>
        <View style={styles.cardContent}>
          {thumbnailUrl ? (
            <Image source={{ uri: thumbnailUrl }} style={styles.thumbnail} />
          ) : (
            <View style={[styles.thumbnail, styles.placeholderThumbnail]}>
              <Text style={styles.placeholderText}>No Image</Text>
            </View>
          )}

          <View style={styles.info}>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.date}>
              Created: {new Date(item.createdAt).toLocaleDateString()}
            </Text>

            {/* Status line */}
            <View style={styles.statusRow}>
              {isProcessing && (
                <ActivityIndicator size="small" color="#FF9500" style={styles.statusSpinner} />
              )}
              <Text style={[styles.modelStatus, { color: statusInfo.color }]}>
                {statusInfo.icon ? `${statusInfo.icon} ` : ''}{statusInfo.text}
              </Text>
            </View>

            {/* Progress bar for processing objects */}
            {isProcessing && (
              <View style={styles.miniProgressContainer}>
                <View
                  style={[
                    styles.miniProgressBar,
                    { width: `${item.generationProgress || 0}%` }
                  ]}
                />
              </View>
            )}
          </View>
        </View>

        <View style={styles.actions}>
          {isCompleted && (
            <TouchableOpacity
              style={[styles.button, styles.view3DButton]}
              onPress={() => handleView3D(item)}
            >
              <Text style={styles.buttonText}>View 3D</Text>
            </TouchableOpacity>
          )}

          {isCompleted && (
            <TouchableOpacity
              style={[styles.button, styles.viewARButton]}
              onPress={() => handleViewAR(item)}
            >
              <Text style={styles.buttonText}>View in AR</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.button, styles.detailsButton]}
            onPress={() => handleViewDetails(item)}
          >
            <Text style={styles.buttonText}>Details</Text>
          </TouchableOpacity>

          {isFailed && (
            <TouchableOpacity
              style={[styles.button, styles.retryButton]}
              onPress={() => handleRegenerate(item.id)}
            >
              <Text style={styles.buttonText}>Retry</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.button, styles.deleteButton]}
            onPress={() => handleDelete(item.id, item.name)}
          >
            <Text style={styles.buttonText}>Delete</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading objects...</Text>
      </View>
    );
  }

  if (objects.length === 0) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.emptyText}>No objects yet</Text>
        <Text style={styles.emptySubtext}>Create your first 3D model to get started</Text>
        <TouchableOpacity
          style={styles.createButton}
          onPress={() => navigation.navigate('CreateObject')}
        >
          <Text style={styles.createButtonText}>Create 3D Model</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <FlatList
      data={objects}
      renderItem={renderItem}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
      }
    />
  );
}

const styles = StyleSheet.create({
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 20,
  },
  loadingText: {
    marginTop: 10,
    fontSize: 16,
    color: '#666',
  },
  list: {
    padding: 15,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginBottom: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    overflow: 'hidden',
  },
  cardContent: {
    flexDirection: 'row',
    padding: 15,
  },
  thumbnail: {
    width: 80,
    height: 80,
    borderRadius: 8,
    marginRight: 15,
  },
  placeholderThumbnail: {
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    color: '#999',
    fontSize: 12,
  },
  info: {
    flex: 1,
    justifyContent: 'center',
  },
  name: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 5,
    color: '#333',
  },
  dimensions: {
    fontSize: 14,
    color: '#666',
    marginBottom: 3,
  },
  type: {
    fontSize: 14,
    color: '#666',
    marginBottom: 3,
  },
  date: {
    fontSize: 12,
    color: '#999',
    marginBottom: 3,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusSpinner: {
    marginRight: 6,
  },
  modelStatus: {
    fontSize: 12,
    fontWeight: '600',
  },
  miniProgressContainer: {
    height: 4,
    backgroundColor: '#E9ECEF',
    borderRadius: 2,
    marginTop: 6,
    overflow: 'hidden',
  },
  miniProgressBar: {
    height: '100%',
    backgroundColor: '#FF9500',
    borderRadius: 2,
  },
  actions: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  button: {
    flex: 1,
    padding: 15,
    alignItems: 'center',
  },
  view3DButton: {
    backgroundColor: '#007AFF',
  },
  viewARButton: {
    backgroundColor: '#34C759',
  },
  detailsButton: {
    backgroundColor: '#5856D6',
  },
  retryButton: {
    backgroundColor: '#FF9500',
  },
  deleteButton: {
    backgroundColor: '#FF3B30',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  emptyText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#333',
    marginBottom: 10,
  },
  emptySubtext: {
    fontSize: 16,
    color: '#999',
    marginBottom: 30,
    textAlign: 'center',
  },
  createButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 30,
    paddingVertical: 15,
    borderRadius: 12,
  },
  createButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
});
