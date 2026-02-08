const express = require('express');
const router = express.Router();
const ObjectModel = require('../models/Object');
const upload = require('../utils/upload');
const modelGenerator = require('../services/modelGenerator');
const path = require('path');
const fs = require('fs');

/**
 * POST /api/objects
 * Create a new object, upload images, and start 3D model generation.
 *
 * Supports two modes via the `async` body param:
 *   async=true  - Background generation; poll GET /:id/status for updates
 *   async=false - (default) Blocks until generation completes (30-120s)
 */
router.post('/', upload.array('images', 4), async (req, res) => {
  try {
    const { name } = req.body;
    const isAsync = req.body.async === 'true' || req.body.async === true;

    if (!name) {
      return res.status(400).json({
        error: 'Missing required field: name'
      });
    }

    const imageUrls = req.files ? req.files.map(file => `/uploads/images/${file.filename}`) : [];
    const imagePaths = req.files ? req.files.map(file => file.path) : [];

    const object = new ObjectModel({
      name,
      imageUrls,
      modelUrl: '',
      generationStatus: 'pending'
    });

    await object.save();

    if (isAsync) {
      object.generationStatus = 'processing';
      await object.save();

      (async () => {
        try {
          const genResult = await modelGenerator.startGeneration(
            object._id.toString(), imagePaths
          );

          object.generationTaskId = genResult.taskId;
          object.generationMethod = genResult.method;
          await object.save();

          pollUntilComplete(object._id.toString(), genResult.taskId, genResult.method);
        } catch (error) {
          console.error(`[Route] Background generation failed for ${object._id}:`, error.message);
          object.generationStatus = 'failed';
          object.generationError = error.message;
          await object.save();
        }
      })();

      console.log(`[Route] Object created (async): ${object.name} (${object._id})`);

      return res.status(201).json({
        success: true,
        object: formatObject(object),
        message: '3D model generation started. Poll /api/objects/:id/status for updates.'
      });

    } else {
      object.generationStatus = 'processing';
      await object.save();

      const startTime = Date.now();
      const modelResult = await modelGenerator.generateModel(
        object._id.toString(), imagePaths
      );

      object.modelUrl = `/uploads/models/${object._id}.glb`;
      object.generationStatus = 'completed';
      object.generationProgress = 100;
      object.generationMethod = modelResult.method;
      object.generationTime = modelResult.generationTime;
      await object.save();

      console.log(`[Route] Object created (sync): ${object.name} (${object._id})`);

      res.status(201).json({
        success: true,
        object: formatObject(object),
        modelInfo: {
          size: modelResult.size,
          generationTime: modelResult.generationTime,
          method: modelResult.method
        }
      });
    }

  } catch (error) {
    console.error('[Route] Error creating object:', error);
    res.status(500).json({
      error: 'Failed to create object',
      message: error.message
    });
  }
});

/**
 * GET /api/objects/:id/status
 * Poll the generation status of an object's 3D model.
 */
router.get('/:id/status', async (req, res) => {
  try {
    const object = await ObjectModel.findById(req.params.id);

    if (!object) {
      return res.status(404).json({ error: 'Object not found' });
    }

    if (object.generationStatus === 'processing' && object.generationTaskId && object.generationMethod !== 'local') {
      try {
        const status = await modelGenerator.checkGenerationStatus(
          object.generationTaskId,
          object.generationMethod,
          object._id.toString()
        );

        object.generationProgress = status.progress || object.generationProgress;

        if (status.status === 'SUCCEEDED') {
          object.generationStatus = 'completed';
          object.generationProgress = 100;
          object.modelUrl = `/uploads/models/${object._id}.glb`;
          await object.save();
        } else if (status.status === 'FAILED') {
          object.generationStatus = 'failed';
          object.generationError = status.error || 'Generation failed';
          await object.save();
        } else {
          await object.save();
        }
      } catch (error) {
        console.error(`[Route] Status check failed for ${object._id}:`, error.message);
        // Don't fail the status endpoint; return current state
      }
    }

    res.json({
      success: true,
      id: object._id,
      generationStatus: object.generationStatus,
      generationProgress: object.generationProgress,
      generationMethod: object.generationMethod,
      generationError: object.generationError,
      modelUrl: object.modelUrl,
      generationTime: object.generationTime
    });

  } catch (error) {
    console.error('[Route] Error checking status:', error);
    res.status(500).json({
      error: 'Failed to check generation status',
      message: error.message
    });
  }
});

/** GET /api/objects - Fetch all objects */
router.get('/', async (req, res) => {
  try {
    const objects = await ObjectModel.find()
      .sort({ createdAt: -1 })
      .select('_id name imageUrls modelUrl generationStatus generationProgress generationMethod generationTime createdAt');

    res.json({
      success: true,
      count: objects.length,
      objects: objects.map(formatObject)
    });

  } catch (error) {
    console.error('[Route] Error fetching objects:', error);
    res.status(500).json({
      error: 'Failed to fetch objects',
      message: error.message
    });
  }
});

/** GET /api/objects/:id - Fetch a single object */
router.get('/:id', async (req, res) => {
  try {
    const object = await ObjectModel.findById(req.params.id);

    if (!object) {
      return res.status(404).json({ error: 'Object not found' });
    }

    res.json({
      success: true,
      object: formatObject(object)
    });

  } catch (error) {
    console.error('[Route] Error fetching object:', error);
    res.status(500).json({
      error: 'Failed to fetch object',
      message: error.message
    });
  }
});

/** DELETE /api/objects/:id - Delete an object and its associated files */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const object = await ObjectModel.findById(id);

    if (!object) {
      return res.status(404).json({ error: 'Object not found' });
    }

    object.imageUrls.forEach(url => {
      const filepath = path.join(__dirname, '../..', url);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
    });

    if (object.modelUrl) {
      const modelPath = path.join(__dirname, '../..', object.modelUrl);
      if (fs.existsSync(modelPath)) {
        fs.unlinkSync(modelPath);
      }
    }

    await ObjectModel.findByIdAndDelete(id);

    console.log(`[Route] Object deleted: ${object.name} (${id})`);

    res.json({
      success: true,
      message: 'Object deleted successfully'
    });

  } catch (error) {
    console.error('[Route] Error deleting object:', error);
    res.status(500).json({
      error: 'Failed to delete object',
      message: error.message
    });
  }
});

/** POST /api/objects/:id/regenerate - Re-generate the 3D model (e.g., after failure) */
router.post('/:id/regenerate', async (req, res) => {
  try {
    const object = await ObjectModel.findById(req.params.id);

    if (!object) {
      return res.status(404).json({ error: 'Object not found' });
    }

    const imagePaths = object.imageUrls.map(url =>
      path.join(__dirname, '../..', url)
    ).filter(p => fs.existsSync(p));

    if (imagePaths.length === 0) {
      return res.status(400).json({ error: 'No images available for regeneration' });
    }

    if (object.modelUrl) {
      const oldModelPath = path.join(__dirname, '../..', object.modelUrl);
      if (fs.existsSync(oldModelPath)) {
        fs.unlinkSync(oldModelPath);
      }
    }

    object.generationStatus = 'processing';
    object.generationProgress = 0;
    object.generationError = '';
    object.modelUrl = '';
    await object.save();

    (async () => {
      try {
        const genResult = await modelGenerator.startGeneration(
          object._id.toString(), imagePaths
        );

        object.generationTaskId = genResult.taskId;
        object.generationMethod = genResult.method;
        await object.save();

        pollUntilComplete(object._id.toString(), genResult.taskId, genResult.method);
      } catch (error) {
        console.error(`[Route] Regeneration failed for ${object._id}:`, error.message);
        object.generationStatus = 'failed';
        object.generationError = error.message;
        await object.save();
      }
    })();

    res.json({
      success: true,
      message: 'Regeneration started. Poll /api/objects/:id/status for updates.',
      object: formatObject(object)
    });

  } catch (error) {
    console.error('[Route] Error regenerating object:', error);
    res.status(500).json({
      error: 'Failed to regenerate object',
      message: error.message
    });
  }
});

/**
 * Background poller for async generation tasks.
 * Periodically checks the task status and updates the database.
 */
async function pollUntilComplete(objectId, taskId, method) {
  const POLL_INTERVAL = 5000;    // 5 seconds
  const MAX_DURATION = 300000;   // 5 minutes
  const startTime = Date.now();

  console.log(`[Poller] Starting for object ${objectId} (${method} task: ${taskId})`);

  while (Date.now() - startTime < MAX_DURATION) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    try {
      const object = await ObjectModel.findById(objectId);
      if (!object || object.generationStatus !== 'processing') {
        console.log(`[Poller] Object ${objectId} no longer processing, stopping.`);
        return;
      }

      const status = await modelGenerator.checkGenerationStatus(taskId, method, objectId);

      if (status.status === 'SUCCEEDED') {
        object.generationStatus = 'completed';
        object.generationProgress = 100;
        object.modelUrl = `/uploads/models/${objectId}.glb`;
        object.generationTime = Date.now() - startTime;
        await object.save();
        console.log(`[Poller] Object ${objectId} generation completed!`);
        return;
      }

      if (status.status === 'FAILED') {
        object.generationStatus = 'failed';
        object.generationError = status.error || 'Generation failed';
        await object.save();
        console.log(`[Poller] Object ${objectId} generation failed: ${status.error}`);
        return;
      }

      if (status.progress > object.generationProgress) {
        object.generationProgress = status.progress;
        await object.save();
      }
    } catch (error) {
      console.error(`[Poller] Error polling object ${objectId}:`, error.message);
    }
  }

  try {
    const object = await ObjectModel.findById(objectId);
    if (object && object.generationStatus === 'processing') {
      object.generationStatus = 'failed';
      object.generationError = 'Generation timed out after 5 minutes';
      await object.save();
      console.log(`[Poller] Object ${objectId} generation timed out.`);
    }
  } catch (error) {
    console.error(`[Poller] Error setting timeout for ${objectId}:`, error.message);
  }
}

/**
 * Format an object document for API response.
 */
function formatObject(obj) {
  return {
    id: obj._id,
    name: obj.name,
    imageUrls: obj.imageUrls,
    modelUrl: obj.modelUrl,
    generationStatus: obj.generationStatus || 'completed',
    generationProgress: obj.generationProgress || (obj.modelUrl ? 100 : 0),
    generationMethod: obj.generationMethod || '',
    generationTime: obj.generationTime || 0,
    createdAt: obj.createdAt
  };
}

module.exports = router;
