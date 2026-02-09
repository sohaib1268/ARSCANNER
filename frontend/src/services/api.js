import axios from 'axios';

// Backend API base URL - update this to your backend server address
const API_BASE_URL = 'http://localhost:3000/api';

class ApiService {

  /**
   * Create a new object with images.
   * Uses async=true so the server starts 3D generation in the background.
   * Returns immediately with the object data and a generation status.
   */
  async createObject(objectData, images) {
    try {
      const formData = new FormData();

      formData.append('name', objectData.name);
      formData.append('async', 'true');

      // Append images
      images.forEach((image, index) => {
        const filename = image.uri.split('/').pop();
        const match = /\.(\w+)$/.exec(filename);
        const type = match ? `image/${match[1]}` : 'image/jpeg';

        formData.append('images', {
          uri: image.uri,
          name: filename,
          type
        });
      });

      const response = await axios.post(`${API_BASE_URL}/objects`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        timeout: 60000 // 60 seconds (upload can take time)
      });

      return response.data;
    } catch (error) {
      console.error('Error creating object:', error);
      throw error;
    }
  }

  /**
   * Create a new object with synchronous (blocking) generation.
   * This will wait until the 3D model is fully generated before returning.
   * Can take 30-120 seconds for AI-based reconstruction.
   */
  async createObjectSync(objectData, images) {
    try {
      const formData = new FormData();

      formData.append('name', objectData.name);
      // async defaults to false

      images.forEach((image, index) => {
        const filename = image.uri.split('/').pop();
        const match = /\.(\w+)$/.exec(filename);
        const type = match ? `image/${match[1]}` : 'image/jpeg';

        formData.append('images', {
          uri: image.uri,
          name: filename,
          type
        });
      });

      const response = await axios.post(`${API_BASE_URL}/objects`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        timeout: 300000 // 5 minutes for full generation
      });

      return response.data;
    } catch (error) {
      console.error('Error creating object (sync):', error);
      throw error;
    }
  }

  /**
   * Poll the generation status of an object's 3D model.
   *
   * @param {string} objectId
   * @returns {{ generationStatus, generationProgress, modelUrl, generationMethod }}
   */
  async getGenerationStatus(objectId) {
    try {
      const response = await axios.get(`${API_BASE_URL}/objects/${objectId}/status`, {
        timeout: 15000
      });
      return response.data;
    } catch (error) {
      console.error('Error checking generation status:', error);
      throw error;
    }
  }

  /**
   * Wait for 3D generation to complete by polling.
   * Returns the final status when complete or failed.
   *
   * @param {string} objectId
   * @param {function} onProgress - callback(progress: 0-100, status: string)
   * @param {number} pollInterval - ms between checks (default 3000)
   * @param {number} maxDuration - ms before timeout (default 300000 = 5 min)
   */
  async waitForGeneration(objectId, onProgress, pollInterval = 3000, maxDuration = 300000) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxDuration) {
      try {
        const status = await this.getGenerationStatus(objectId);

        if (onProgress) {
          onProgress(status.generationProgress || 0, status.generationStatus);
        }

        if (status.generationStatus === 'completed') {
          return status;
        }

        if (status.generationStatus === 'failed') {
          throw new Error(status.generationError || 'Model generation failed');
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (error) {
        // If it's a generation error (not a network error), rethrow
        if (error.message && !error.message.includes('Network')) {
          throw error;
        }
        // For network errors, wait and retry
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    throw new Error('Model generation timed out');
  }

  /**
   * Fetch all objects from the backend
   */
  async getObjects() {
    try {
      const response = await axios.get(`${API_BASE_URL}/objects`);
      return response.data.objects;
    } catch (error) {
      console.error('Error fetching objects:', error);
      throw error;
    }
  }

  /**
   * Fetch a single object by ID
   */
  async getObject(objectId) {
    try {
      const response = await axios.get(`${API_BASE_URL}/objects/${objectId}`);
      return response.data.object;
    } catch (error) {
      console.error('Error fetching object:', error);
      throw error;
    }
  }

  /**
   * Delete an object by ID
   */
  async deleteObject(objectId) {
    try {
      const response = await axios.delete(`${API_BASE_URL}/objects/${objectId}`);
      return response.data;
    } catch (error) {
      console.error('Error deleting object:', error);
      throw error;
    }
  }

  /**
   * Regenerate the 3D model for an existing object
   */
  async regenerateModel(objectId) {
    try {
      const response = await axios.post(`${API_BASE_URL}/objects/${objectId}/regenerate`, {}, {
        timeout: 30000
      });
      return response.data;
    } catch (error) {
      console.error('Error regenerating model:', error);
      throw error;
    }
  }

  /**
   * Get full URL for a model or image
   */
  getFullUrl(relativePath) {
    if (!relativePath) return null;
    return API_BASE_URL.replace('/api', '') + relativePath;
  }
}

export default new ApiService();
