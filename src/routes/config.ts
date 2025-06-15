import { Router, Request, Response } from 'express';
import { shopNotionStore } from '../services/shopNotionStore';
import { NotionService } from '../services/notion';

const router = Router();

/**
 * POST /config
 * Store Notion configuration for a shop
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { shopDomain, notionToken, notionDbId } = req.body;

    // Validate required fields
    if (!shopDomain || !notionToken || !notionDbId) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'shopDomain, notionToken, and notionDbId are required',
        received: {
          shopDomain: !!shopDomain,
          notionToken: !!notionToken,
          notionDbId: !!notionDbId
        }
      });
    }

    console.log(`📝 Storing config for shop: ${shopDomain}`);

    // Test the Notion connection before storing
    try {
      const testNotionService = new NotionService(notionToken, notionDbId);
      const connectionTest = await testNotionService.testConnection();
      
      if (!connectionTest) {
        return res.status(400).json({
          error: 'Invalid Notion configuration',
          message: 'Could not connect to Notion with provided token and database ID'
        });
      }
    } catch (notionError) {
      console.error('❌ Notion connection test failed:', notionError);
      return res.status(400).json({
        error: 'Invalid Notion configuration',
        message: 'Could not connect to Notion with provided credentials',
        details: notionError instanceof Error ? notionError.message : 'Unknown error'
      });
    }

    // Store the configuration
    shopNotionStore.setConfig(shopDomain, notionToken, notionDbId);

    res.json({
      success: true,
      message: 'Shop configuration stored successfully',
      data: {
        shopDomain: shopDomain,
        notionDbId: notionDbId,
        storedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Error storing shop config:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to store shop configuration',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /config/:shopDomain
 * Get Notion configuration for a shop
 */
router.get('/:shopDomain', (req: Request, res: Response) => {
  try {
    const { shopDomain } = req.params;
    const config = shopNotionStore.getConfig(shopDomain);

    if (!config) {
      return res.status(404).json({
        error: 'Configuration not found',
        message: `No Notion configuration found for shop: ${shopDomain}`
      });
    }

    // Don't expose the full token in the response
    res.json({
      success: true,
      data: {
        shopDomain: config.shopDomain,
        notionDbId: config.notionDbId,
        notionToken: '***' + config.notionToken.slice(-4),
        createdAt: config.createdAt,
        updatedAt: config.updatedAt
      }
    });

  } catch (error) {
    console.error('❌ Error getting shop config:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get shop configuration'
    });
  }
});

/**
 * DELETE /config/:shopDomain
 * Remove Notion configuration for a shop
 */
router.delete('/:shopDomain', (req: Request, res: Response) => {
  try {
    const { shopDomain } = req.params;
    const deleted = shopNotionStore.removeConfig(shopDomain);

    if (!deleted) {
      return res.status(404).json({
        error: 'Configuration not found',
        message: `No configuration found for shop: ${shopDomain}`
      });
    }

    res.json({
      success: true,
      message: 'Shop configuration removed successfully',
      data: {
        shopDomain: shopDomain,
        removedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Error removing shop config:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to remove shop configuration'
    });
  }
});

/**
 * GET /config
 * Get all stored configurations (admin endpoint)
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const stats = shopNotionStore.getStats();
    const configs = shopNotionStore.getAllConfigs().map(config => ({
      shopDomain: config.shopDomain,
      notionDbId: config.notionDbId,
      notionToken: '***' + config.notionToken.slice(-4),
      createdAt: config.createdAt,
      updatedAt: config.updatedAt
    }));

    res.json({
      success: true,
      stats: stats,
      configurations: configs
    });

  } catch (error) {
    console.error('❌ Error getting all configs:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get configurations'
    });
  }
});

export default router; 