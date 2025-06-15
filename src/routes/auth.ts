import { Router, Request, Response } from 'express';
import { ShopifyService } from '../services/shopify';
import { userStoreService } from '../services/userStore';

const router = Router();

// Initialize Shopify service
let shopifyService: ShopifyService;

try {
  shopifyService = new ShopifyService();
} catch (error) {
  console.error('Failed to initialize Shopify service:', error);
}

/**
 * GET /auth
 * Initiates OAuth flow - redirects shop to Shopify OAuth
 * Query params: shop, email?, notionToken?, notionDbId?
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const { shop, email, notionToken, notionDbId } = req.query;

    if (!shop || typeof shop !== 'string') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing shop parameter'
      });
    }

    if (!shopifyService) {
      return res.status(500).json({
        error: 'Service Configuration Error',
        message: 'Shopify service not properly configured'
      });
    }

    // Clean shop name (remove .myshopify.com if present)
    const shopName = shop.replace('.myshopify.com', '');
    
    // Store user info in state for callback
    const state = JSON.stringify({
      email: email || '',
      notionToken: notionToken || process.env.NOTION_TOKEN || '',
      notionDbId: notionDbId || process.env.NOTION_DB_ID || ''
    });
    
    // Generate OAuth URL with state
    const authUrl = shopifyService.generateAuthUrl(shopName, state);
    
    console.log(`🔐 Redirecting ${shopName} to OAuth: ${authUrl}`);
    
    // Redirect to Shopify OAuth
    res.redirect(authUrl);

  } catch (error) {
    console.error('❌ Error in OAuth initiation:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to initiate OAuth'
    });
  }
});

/**
 * GET /auth/callback
 * Handles OAuth callback from Shopify
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    console.log('📥 Received OAuth callback:', req.query);

    if (!shopifyService) {
      return res.status(500).json({
        error: 'Service Configuration Error',
        message: 'Shopify service not properly configured'
      });
    }

    const { shop, code, hmac, state } = req.query;

    // Validate required parameters
    if (!shop || !code || !hmac) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required OAuth parameters'
      });
    }

    // Verify OAuth callback
    if (!shopifyService.verifyOAuthCallback(req.query)) {
      console.error('❌ Invalid OAuth callback verification');
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid OAuth callback'
      });
    }

    console.log('✅ OAuth callback verified');

    const shopName = (shop as string).replace('.myshopify.com', '');

    // Parse state to get user info
    let userInfo = { email: '', notionToken: '', notionDbId: '' };
    if (state && typeof state === 'string') {
      try {
        userInfo = JSON.parse(state);
      } catch (e) {
        console.warn('Failed to parse state:', e);
      }
    }

    // Use fallback values if not provided
    const email = userInfo.email || `user-${shopName}@shopify.local`;
    const notionToken = userInfo.notionToken || process.env.NOTION_TOKEN || '';
    const notionDbId = userInfo.notionDbId || process.env.NOTION_DB_ID || '';

    if (!notionToken || !notionDbId) {
      console.error('❌ Missing Notion configuration');
      const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
      const errorUrl = `${appUrl}/app?shop=${shopName}.myshopify.com&error=${encodeURIComponent('Notion configuration missing. Please contact support.')}`;
      return res.redirect(errorUrl);
    }

    // Exchange code for access token
    const accessToken = await shopifyService.getAccessToken(shopName, code as string);
    console.log(`🔑 Got access token for ${shopName}`);

    // Get shop information
    const shopInfo = await shopifyService.getShopInfo(shopName, accessToken);
    console.log(`🏪 Shop info: ${shopInfo.name} (${shopInfo.domain})`);

    // Create or get user
    const user = userStoreService.createOrGetUser(email, notionToken, notionDbId);
    
    // Add store to user
    userStoreService.addStoreToUser(user.id, shopName, shopInfo.domain, accessToken);

    // Create order webhook (non-blocking)
    try {
      const webhook = await shopifyService.createOrderWebhook(shopName, accessToken);
      console.log(`🎯 Created webhook with ID: ${webhook.webhook.id}`);
    } catch (webhookError) {
      console.warn(`⚠️ Failed to create webhook for ${shopName}:`, webhookError instanceof Error ? webhookError.message : webhookError);
      // Continue with the flow even if webhook creation fails
    }

    // Create session for user
    const sessionId = userStoreService.createSession(user.id);

    // Redirect to embedded app interface
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    const redirectUrl = `${appUrl}/app?shop=${shopInfo.domain}&installed=true`;
    
    console.log(`🔄 Redirecting to embedded app: ${redirectUrl}`);
    res.redirect(redirectUrl);

    console.log(`🎉 Successfully installed app for ${shopName} (User: ${user.id})`);

  } catch (error) {
    console.error('❌ Error in OAuth callback:', error);
    console.error('❌ Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    
    // Redirect to embedded app with error instead of returning JSON
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    const shopName = req.query.shop ? (req.query.shop as string).replace('.myshopify.com', '') : 'unknown';
    const errorMessage = error instanceof Error ? error.message : 'Failed to complete OAuth flow';
    const errorUrl = `${appUrl}/app?shop=${shopName}.myshopify.com&error=${encodeURIComponent(errorMessage)}`;
    
    res.redirect(errorUrl);
  }
});



/**
 * GET /auth/dashboard
 * Get user dashboard with all connected stores
 */
router.get('/dashboard', (req: Request, res: Response) => {
  try {
    const sessionId = req.headers.authorization?.replace('Bearer ', '');
    
    if (!sessionId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Session ID required'
      });
    }

    const user = userStoreService.getUserBySession(sessionId);
    if (!user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired session'
      });
    }

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          createdAt: user.createdAt,
          notionDbId: user.notionDbId
        },
        stores: user.stores.filter(s => s.isActive).map(store => ({
          shopName: store.shopName,
          shopDomain: store.shopDomain,
          connectedAt: store.connectedAt,
          isActive: store.isActive
        })),
        stats: {
          totalStores: user.stores.filter(s => s.isActive).length,
          totalConnections: user.stores.length
        }
      }
    });

  } catch (error) {
    console.error('❌ Error getting dashboard:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get dashboard'
    });
  }
});

/**
 * DELETE /auth/store/:shopName
 * Remove a store from user's account
 */
router.delete('/store/:shopName', (req: Request, res: Response) => {
  try {
    const sessionId = req.headers.authorization?.replace('Bearer ', '');
    const { shopName } = req.params;
    
    if (!sessionId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Session ID required'
      });
    }

    const user = userStoreService.getUserBySession(sessionId);
    if (!user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired session'
      });
    }

    const removed = userStoreService.removeStoreFromUser(user.id, shopName);
    
    if (removed) {
      res.json({
        success: true,
        message: `Store ${shopName} removed successfully`
      });
    } else {
      res.status(404).json({
        error: 'Not Found',
        message: 'Store not found'
      });
    }

  } catch (error) {
    console.error('❌ Error removing store:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to remove store'
    });
  }
});

/**
 * GET /auth/stats
 * Get system stats
 */
router.get('/stats', (req: Request, res: Response) => {
  try {
    const stats = userStoreService.getStats();
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('❌ Error getting stats:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get stats'
    });
  }
});

export default router; 