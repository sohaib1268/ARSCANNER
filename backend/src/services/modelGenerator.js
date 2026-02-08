const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const FormData = require('form-data');

const MESHY_API_KEY = process.env.MESHY_API_KEY || '';
const TRIPO_API_KEY = process.env.TRIPO_API_KEY || '';

const MESHY_BASE_URL = 'https://api.meshy.ai/openapi/v1';
const TRIPO_BASE_URL = 'https://api.tripo3d.ai/v2/openapi';

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_DURATION_MS = 300000;
const MODELS_DIR = path.join(__dirname, '../../uploads/models');

/**
 * ModelGenerator - Real 3D reconstruction from images.
 *
 * Uses AI-powered 3D reconstruction services:
 *   1. Meshy.ai Image-to-3D API  (primary - best quality, base64 upload)
 *   2. Tripo AI Image-to-3D API  (fallback - good quality, file upload)
 *
 * At least one API key must be configured for the service to work.
 * All services output GLB files that are saved to uploads/models/.
 */
class ModelGenerator {

  constructor() {
    if (!fs.existsSync(MODELS_DIR)) {
      fs.mkdirSync(MODELS_DIR, { recursive: true });
    }

    if (MESHY_API_KEY) {
      console.log('[ModelGenerator] Meshy.ai API key configured (primary)');
    }
    if (TRIPO_API_KEY) {
      console.log('[ModelGenerator] Tripo AI API key configured (fallback)');
    }
    if (!MESHY_API_KEY && !TRIPO_API_KEY) {
      console.error('[ModelGenerator] No 3D reconstruction API keys configured. Please set MESHY_API_KEY or TRIPO_API_KEY');
    }
  }

  /**
   * Generate a 3D model from uploaded images.
   *
   * @param {string} objectId - unique id used for the output filename
   * @param {string[]} imagePaths - absolute paths to uploaded images (1-4)
   * @returns {{ path: string, size: number, generationTime: number, method: string }}
   */
  async generateModel(objectId, imagePaths = []) {
    const startTime = Date.now();
    const outputPath = path.join(MODELS_DIR, `${objectId}.glb`);

    const services = [];

    if (MESHY_API_KEY) {
      services.push({
        name: 'meshy',
        fn: () => this.generateWithMeshy(imagePaths, outputPath)
      });
    }

    if (TRIPO_API_KEY) {
      services.push({
        name: 'tripo',
        fn: () => this.generateWithTripo(imagePaths, outputPath)
      });
    }

    if (services.length === 0) {
      throw new Error('No 3D reconstruction API keys configured. Please set MESHY_API_KEY or TRIPO_API_KEY');
    }

    let lastError = null;
    let methodUsed = 'none';

    for (const service of services) {
      try {
        console.log(`[ModelGenerator] Trying ${service.name}...`);
        await service.fn();
        methodUsed = service.name;
        console.log(`[ModelGenerator] Successfully generated with ${service.name}`);
        break;
      } catch (error) {
        lastError = error;
        console.error(`[ModelGenerator] ${service.name} failed:`, error.message);
      }
    }

    if (methodUsed === 'none') {
      throw new Error(`All 3D generation methods failed. Last error: ${lastError?.message}`);
    }

    const elapsedTime = Date.now() - startTime;
    const stats = fs.statSync(outputPath);

    console.log(`[ModelGenerator] Model generated in ${(elapsedTime / 1000).toFixed(1)}s using ${methodUsed} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);

    return {
      path: outputPath,
      size: stats.size,
      generationTime: elapsedTime,
      method: methodUsed
    };
  }

  /**
   * Start asynchronous 3D generation and return a task ID for polling.
   * This is the preferred method for the API route since generation can
   * take 30-120 seconds.
   *
   * @param {string} objectId - unique id for the object
   * @param {string[]} imagePaths - absolute paths to uploaded images
   * @returns {{ taskId: string, method: string }}
   */
  async startGeneration(objectId, imagePaths = []) {
    if (MESHY_API_KEY && imagePaths.length > 0) {
      try {
        const imageBase64 = await this.imageToBase64DataURI(imagePaths[0]);
        const taskId = await this.meshyCreateTask(imageBase64);
        return { taskId, method: 'meshy', objectId };
      } catch (error) {
        console.error('[ModelGenerator] Failed to start Meshy task:', error.message);
      }
    }

    if (TRIPO_API_KEY && imagePaths.length > 0) {
      try {
        const fileToken = await this.tripoUploadImage(imagePaths[0]);
        const taskId = await this.tripoCreateTask(fileToken);
        return { taskId, method: 'tripo', objectId };
      } catch (error) {
        console.error('[ModelGenerator] Failed to start Tripo task:', error.message);
      }
    }

    throw new Error('No 3D reconstruction API keys configured. Please set MESHY_API_KEY or TRIPO_API_KEY');
  }

  /**
   * Check the status of a running generation task.
   *
   * @param {string} taskId - the task ID returned by startGeneration
   * @param {string} method - 'meshy' or 'tripo'
   * @param {string} objectId - the object ID for saving the file
   * @returns {{ status: string, progress: number, modelPath?: string, error?: string }}
   */
  async checkGenerationStatus(taskId, method, objectId) {
    const outputPath = path.join(MODELS_DIR, `${objectId}.glb`);

    if (method === 'meshy') {
      return await this.meshyCheckAndDownload(taskId, outputPath);
    }

    if (method === 'tripo') {
      return await this.tripoCheckAndDownload(taskId, outputPath);
    }

    return { status: 'FAILED', progress: 0, error: `Unknown method: ${method}` };
  }

  /**
   * Generate a 3D model using Meshy.ai Image-to-3D API.
   * This is the synchronous version that polls until completion.
   */
  async generateWithMeshy(imagePaths, outputPath) {
    if (!imagePaths.length) {
      throw new Error('At least one image is required');
    }

    const imageBase64 = await this.imageToBase64DataURI(imagePaths[0]);
    const taskId = await this.meshyCreateTask(imageBase64);
    console.log(`[Meshy] Task created: ${taskId}`);

    const result = await this.meshyPollUntilDone(taskId);
    await this.downloadFile(result.model_urls.glb, outputPath);
    console.log(`[Meshy] GLB downloaded to ${outputPath}`);
  }

  /**
   * Create an Image-to-3D task on Meshy.
   * @param {string} imageDataURI - base64 data URI (data:image/png;base64,...)
   * @returns {string} taskId
   */
  async meshyCreateTask(imageDataURI) {
    const response = await axios.post(
      `${MESHY_BASE_URL}/image-to-3d`,
      {
        image_url: imageDataURI,
        ai_model: 'latest',
        topology: 'triangle',
        target_polycount: 30000,
        should_remesh: true,
        should_texture: true,
        enable_pbr: true
      },
      {
        headers: {
          'Authorization': `Bearer ${MESHY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    return response.data.result;
  }

  /**
   * Poll Meshy task until it reaches SUCCEEDED or FAILED.
   */
  async meshyPollUntilDone(taskId) {
    const deadline = Date.now() + MAX_POLL_DURATION_MS;

    while (Date.now() < deadline) {
      const task = await this.meshyGetTask(taskId);

      if (task.status === 'SUCCEEDED') {
        return task;
      }

      if (task.status === 'FAILED' || task.status === 'CANCELED') {
        const errMsg = task.task_error?.message || 'Task failed without error message';
        throw new Error(`Meshy task failed: ${errMsg}`);
      }

      console.log(`[Meshy] Task ${taskId}: ${task.status} (${task.progress || 0}%)`);
      await this.sleep(POLL_INTERVAL_MS);
    }

    throw new Error('Meshy task timed out after 5 minutes');
  }

  /**
   * Get the current status of a Meshy task.
   */
  async meshyGetTask(taskId) {
    const response = await axios.get(
      `${MESHY_BASE_URL}/image-to-3d/${taskId}`,
      {
        headers: {
          'Authorization': `Bearer ${MESHY_API_KEY}`
        },
        timeout: 15000
      }
    );
    return response.data;
  }

  /**
   * Check Meshy task status and download if complete.
   */
  async meshyCheckAndDownload(taskId, outputPath) {
    try {
      const task = await this.meshyGetTask(taskId);

      if (task.status === 'SUCCEEDED') {
        if (!fs.existsSync(outputPath)) {
          await this.downloadFile(task.model_urls.glb, outputPath);
        }
        return {
          status: 'SUCCEEDED',
          progress: 100,
          modelPath: outputPath
        };
      }

      if (task.status === 'FAILED' || task.status === 'CANCELED') {
        return {
          status: 'FAILED',
          progress: task.progress || 0,
          error: task.task_error?.message || 'Task failed'
        };
      }

      return {
        status: task.status,
        progress: task.progress || 0
      };
    } catch (error) {
      return {
        status: 'FAILED',
        progress: 0,
        error: error.message
      };
    }
  }

  /**
   * Generate a 3D model using Tripo AI Image-to-3D API.
   * This is the synchronous version that polls until completion.
   */
  async generateWithTripo(imagePaths, outputPath) {
    if (!imagePaths.length) {
      throw new Error('At least one image is required');
    }

    const fileToken = await this.tripoUploadImage(imagePaths[0]);
    console.log(`[Tripo] Image uploaded, token: ${fileToken}`);

    const taskId = await this.tripoCreateTask(fileToken);
    console.log(`[Tripo] Task created: ${taskId}`);

    const task = await this.tripoPollUntilDone(taskId);

    const glbUrl = task.output?.model ||
                   task.output?.pbr_model ||
                   task.output?.base_model ||
                   task.result?.model ||
                   task.model;

    if (!glbUrl) {
      console.error('[Tripo] Available fields in task:', Object.keys(task));
      console.error('[Tripo] Available fields in task.output:', task.output ? Object.keys(task.output) : 'N/A');
      throw new Error(`Tripo task completed but no model URL found in response. Available fields: ${Object.keys(task).join(', ')}`);
    }

    console.log(`[Tripo] Found model URL: ${glbUrl}`);
    await this.downloadFile(glbUrl, outputPath);
    console.log(`[Tripo] GLB downloaded to ${outputPath}`);
  }

  /**
   * Upload an image to Tripo and get a file token.
   */
  async tripoUploadImage(imagePath) {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(imagePath));

    const response = await axios.post(
      `${TRIPO_BASE_URL}/upload`,
      formData,
      {
        headers: {
          'Authorization': `Bearer ${TRIPO_API_KEY}`,
          ...formData.getHeaders()
        },
        timeout: 30000
      }
    );

    if (response.data.code !== 0) {
      throw new Error(`Tripo upload failed: ${response.data.message || 'Unknown error'}`);
    }

    return response.data.data.image_token;
  }

  /**
   * Create an Image-to-3D task on Tripo.
   */
  async tripoCreateTask(fileToken) {
    const response = await axios.post(
      `${TRIPO_BASE_URL}/task`,
      {
        type: 'image_to_model',
        file: {
          type: 'image',
          file_token: fileToken
        },
        model_version: 'v2.0-20240919',
        face_limit: 30000,
        texture: true,
        pbr: true
      },
      {
        headers: {
          'Authorization': `Bearer ${TRIPO_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    if (response.data.code !== 0) {
      throw new Error(`Tripo task creation failed: ${response.data.message || 'Unknown error'}`);
    }

    return response.data.data.task_id;
  }

  /**
   * Poll Tripo task until it reaches success or failure.
   */
  async tripoPollUntilDone(taskId) {
    const deadline = Date.now() + MAX_POLL_DURATION_MS;

    while (Date.now() < deadline) {
      const task = await this.tripoGetTask(taskId);
      const status = task.status;

      if (status === 'success') {
        console.log('[Tripo] Task completed successfully. Full response:', JSON.stringify(task, null, 2));
        return task;
      }

      if (status === 'failed' || status === 'cancelled' || status === 'unknown') {
        throw new Error(`Tripo task failed with status: ${status}`);
      }

      console.log(`[Tripo] Task ${taskId}: ${status} (${task.progress || 0}%)`);
      await this.sleep(POLL_INTERVAL_MS);
    }

    throw new Error('Tripo task timed out after 5 minutes');
  }

  /**
   * Get the current status of a Tripo task.
   */
  async tripoGetTask(taskId) {
    const response = await axios.get(
      `${TRIPO_BASE_URL}/task/${taskId}`,
      {
        headers: {
          'Authorization': `Bearer ${TRIPO_API_KEY}`
        },
        timeout: 15000
      }
    );

    if (response.data.code !== 0) {
      throw new Error(`Tripo status check failed: ${response.data.message || 'Unknown error'}`);
    }

    return response.data.data;
  }

  /**
   * Check Tripo task status and download if complete.
   */
  async tripoCheckAndDownload(taskId, outputPath) {
    try {
      const task = await this.tripoGetTask(taskId);

      if (task.status === 'success') {
        // Try multiple possible field locations for the model URL
        const glbUrl = task.output?.model ||
                       task.output?.pbr_model ||
                       task.output?.base_model ||
                       task.result?.model ||
                       task.model;

        if (!glbUrl) {
          console.error('[Tripo] No model URL found. Task structure:', JSON.stringify(task, null, 2));
          return {
            status: 'FAILED',
            progress: 100,
            error: `No model URL in response. Available fields: ${Object.keys(task).join(', ')}`
          };
        }

        if (!fs.existsSync(outputPath)) {
          console.log(`[Tripo] Downloading model from: ${glbUrl}`);
          await this.downloadFile(glbUrl, outputPath);
        }
        return {
          status: 'SUCCEEDED',
          progress: 100,
          modelPath: outputPath
        };
      }

      if (task.status === 'failed' || task.status === 'cancelled') {
        return {
          status: 'FAILED',
          progress: task.progress || 0,
          error: `Tripo task ${task.status}`
        };
      }

      return {
        status: task.status === 'running' ? 'IN_PROGRESS' : 'PENDING',
        progress: task.progress || 0
      };
    } catch (error) {
      return {
        status: 'FAILED',
        progress: 0,
        error: error.message
      };
    }
  }

  /**
   * Convert a local image file to a base64 data URI suitable for Meshy API.
   * Images are resized to max 1024px to keep the payload reasonable.
   */
  async imageToBase64DataURI(imagePath) {
    const imageBuffer = await sharp(imagePath)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();

    const base64 = imageBuffer.toString('base64');
    return `data:image/png;base64,${base64}`;
  }

  /**
   * Download a file from a URL and save it to disk.
   */
  async downloadFile(url, outputPath) {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 120000 // 2 minutes for large files
    });

    fs.writeFileSync(outputPath, Buffer.from(response.data));
  }

  /**
   * Sleep for the specified number of milliseconds.
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new ModelGenerator();
