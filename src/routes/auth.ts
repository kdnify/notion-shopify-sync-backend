import { Router, Request, Response } from 'express';
import { ShopifyService } from '../services/shopify';
import { userStoreService } from '../services/userStore';
import { NotionService } from '../services/notion';

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
    const { shop, email, notionToken, notionDbId, source } = req.query;

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
      notionDbId: notionDbId || process.env.NOTION_DB_ID || '',
      source: source || 'direct' // Track if this is from setup flow
    });
    
    // Generate OAuth URL with state
    const authUrl = shopifyService.generateAuthUrl(shopName, state);
    
    console.log(`🔐 Redirecting ${shopName} to OAuth: ${authUrl} (source: ${source || 'direct'})`);
    
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
    const user = await userStoreService.createOrGetUser(email, notionToken, notionDbId);
    
    // Add store to user
    await userStoreService.addStoreToUser(user.id, shopName, shopInfo.domain, accessToken);

    // 🆕 AUTO-CREATE PERSONAL NOTION DATABASE
    try {
      console.log(`🏗️ Creating personal Notion database for ${shopName}...`);
      
      // Call our personal database creation endpoint internally
      const createDbResponse = await fetch(`${req.protocol}://${req.get('host')}/notion/create-db-with-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          shopDomain: shopInfo.domain,
          accessToken: notionToken, // Use user's personal Notion token
          workspaceId: 'user-workspace' // Will be handled by the endpoint
        })
      });

      if (createDbResponse.ok) {
        const dbResult = await createDbResponse.json() as { success: boolean; dbId: string; message: string };
        console.log(`✅ Created personal database: ${dbResult.dbId}`);
        
        // Update user with the new personal database ID
        const updateSuccess = await userStoreService.updateUserNotionDb(user.id, dbResult.dbId);
        console.log(`📊 Updated user ${user.id} with personal database: ${dbResult.dbId} - Success: ${updateSuccess}`);
        
        // Verify the update worked
        const updatedUser = await userStoreService.getUser(user.id);
        console.log(`🔍 Verification - User ${user.id} now has database: ${updatedUser?.notionDbId}`);
      } else {
        const errorText = await createDbResponse.text();
        console.warn(`⚠️ Failed to create personal database for ${shopName}: ${errorText}`);
      }
    } catch (dbError) {
      console.warn(`⚠️ Database creation failed for ${shopName}:`, dbError instanceof Error ? dbError.message : dbError);
      // Continue with default database - don't break the installation
    }

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

    // Check if this is from the setup flow
    const isSetupFlow = req.query.state && typeof req.query.state === 'string' && 
                       JSON.parse(req.query.state).source === 'setup';

    // Redirect to embedded app interface
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    let redirectUrl;
    
    if (isSetupFlow) {
      // For setup flow, redirect to app with setup parameter to auto-trigger Notion connection
      redirectUrl = `${appUrl}/app?shop=${shopInfo.domain}&installed=true&setup=true`;
    } else {
      // Normal installation flow
      redirectUrl = `${appUrl}/app?shop=${shopInfo.domain}&installed=true`;
    }
    
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
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers.authorization?.replace('Bearer ', '');
    
    if (!sessionId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Session ID required'
      });
    }

    const user = await userStoreService.getUserBySession(sessionId);
    if (!user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired session'
      });
    }

    // Get user's stores
    const usersWithStore = await userStoreService.getAllUsersWithStore(user.id);
    const stores = await Promise.all(usersWithStore.map(async ({ store }) => ({
      shopName: store.shopName,
      shopDomain: store.shopDomain,
      connectedAt: store.connectedAt,
      isActive: store.isActive
    })));

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          createdAt: user.createdAt,
          notionDbId: user.notionDbId
        },
        stores,
        stats: {
          totalStores: stores.filter(s => s.isActive).length,
          totalConnections: stores.length
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
router.delete('/store/:shopName', async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers.authorization?.replace('Bearer ', '');
    const { shopName } = req.params;
    
    if (!sessionId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Session ID required'
      });
    }

    const user = await userStoreService.getUserBySession(sessionId);
    if (!user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired session'
      });
    }

    const removed = await userStoreService.removeStoreFromUser(user.id, shopName);
    
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

/**
 * GET /auth/webhooks-debug
 * Debug endpoint to list existing webhooks for a shop
 */
router.get('/webhooks-debug', async (req: Request, res: Response) => {
  try {
    const { shop } = req.query;
    
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

    const shopName = shop.replace('.myshopify.com', '');
    
    // Get user and store info to get access token
    const usersWithStore = await userStoreService.getAllUsersWithStore(shopName);
    
    if (usersWithStore.length === 0) {
      return res.status(404).json({
        error: 'Not Found',
        message: `No users found with store ${shopName} connected`
      });
    }

    const { store } = await usersWithStore[0]; // Use first user's store
    
    // List existing webhooks
    const webhooks = await shopifyService.listWebhooks(shopName, store.accessToken);
    
    res.json({
      success: true,
      shop: shopName,
      webhookCount: webhooks.length,
      webhooks: webhooks.map(webhook => ({
        id: webhook.id,
        topic: webhook.topic,
        address: webhook.address,
        created_at: webhook.created_at,
        updated_at: webhook.updated_at
      }))
    });

  } catch (error) {
    console.error('❌ Error listing webhooks:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to list webhooks',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * GET /auth/user-info
 * Get user information including notion database ID for a shop
 */
router.get('/user-info', async (req: Request, res: Response) => {
  try {
    const { shop } = req.query;
    
    if (!shop || typeof shop !== 'string') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing shop parameter'
      });
    }

    // Clean shop name
    const shopName = shop.replace('.myshopify.com', '');
    
    // Find users with this store
    const usersWithStore = await userStoreService.getAllUsersWithStore(shopName);
    
    if (usersWithStore.length === 0) {
      return res.status(404).json({
        error: 'Store Not Found',
        message: `No users found with store ${shopName} connected`
      });
    }

    // Return info for the first user (could be enhanced to handle multiple users)
    const { user } = await usersWithStore[0];
    
    res.json({
      success: true,
      data: {
        userId: user.id,
        email: user.email,
        notionDbId: user.notionDbId,
        shopName: shopName,
        hasDatabase: !!user.notionDbId
      }
    });

  } catch (error) {
    console.error('❌ Error getting user info:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get user information'
    });
  }
});

/**
 * POST /auth/update-notion-db
 * Update Notion Database ID for a specific shop
 */
router.post('/update-notion-db', async (req: Request, res: Response) => {
  try {
    const { shop, notionDbId } = req.body;
    
    if (!shop || !notionDbId) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing shop or notionDbId parameter'
      });
    }

    // Clean shop name
    const shopName = shop.replace('.myshopify.com', '');
    
    // Validate Database ID format
    const cleanDbId = notionDbId.replace(/-/g, '');
    if (cleanDbId.length < 32 || !/^[a-f0-9]+$/i.test(cleanDbId)) {
      return res.status(400).json({
        error: 'Invalid Database ID',
        message: 'Notion Database ID format is invalid'
      });
    }

    // Find users with this store
    const usersWithStore = await userStoreService.getAllUsersWithStore(shopName);
    
    if (usersWithStore.length === 0) {
      return res.status(404).json({
        error: 'Store Not Found',
        message: `No users found with store ${shopName} connected`
      });
    }

    // Update the Notion DB ID for all users with this store
    let updatedCount = 0;
    for (const { user } of usersWithStore) {
      const success = await userStoreService.updateUserNotionDb(user.id, notionDbId);
      if (success) {
        updatedCount++;
      }
    }

    console.log(`📊 Updated Notion DB ID for ${updatedCount} users with store ${shopName}`);
    console.log(`🔗 New Notion DB ID: ${notionDbId}`);

    res.json({
      success: true,
      message: `Notion database updated for ${updatedCount} user(s)`,
      data: {
        shopName: shopName,
        notionDbId: notionDbId,
        updatedUsers: updatedCount
      }
    });

  } catch (error) {
    console.error('❌ Error updating Notion DB:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update Notion database'
    });
  }
});

/**
 * GET /auth/notion-callback
 * Handles Notion OAuth callback and creates personal database
 */
router.get('/notion-callback', async (req: Request, res: Response) => {
  try {
    console.log('📥 Received Notion OAuth callback:', req.query);

    const { code, state, error } = req.query;

    if (error) {
      console.error('❌ Notion OAuth error:', error);
      const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
      return res.redirect(`${appUrl}/app?shop=unknown&error=${encodeURIComponent('Notion authorization failed')}`);
    }

    if (!code || !state) {
      console.error('❌ Missing code or state in Notion callback');
      const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
      return res.redirect(`${appUrl}/app?shop=unknown&error=${encodeURIComponent('Invalid Notion callback')}`);
    }

    // Parse state to get shop info
    let stateData;
    try {
      stateData = JSON.parse(decodeURIComponent(state as string));
    } catch (e) {
      console.error('❌ Failed to parse state:', e);
      const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
      return res.redirect(`${appUrl}/app?shop=unknown&error=${encodeURIComponent('Invalid state parameter')}`);
    }

    const shopDomain = stateData.shop;
    const shopName = shopDomain.replace('.myshopify.com', '');

    console.log(`🔑 Processing Notion OAuth for shop: ${shopName}`);

    // Exchange code for access token
    const clientId = process.env.NOTION_OAUTH_CLIENT_ID || '212d872b-594c-80fd-ae95-0037202a219e';
    const clientSecret = process.env.NOTION_OAUTH_CLIENT_SECRET || '';

    if (!clientSecret) {
      console.error('❌ Missing NOTION_OAUTH_CLIENT_SECRET');
      const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
      return res.redirect(`${appUrl}/app?shop=${shopDomain}&error=${encodeURIComponent('Notion OAuth not configured')}`);
    }

    const tokenResponse = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: 'https://notion-shopify-sync-backend.onrender.com/auth/notion-callback'
      })
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('❌ Failed to exchange Notion code for token:', errorText);
      const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
      return res.redirect(`${appUrl}/app?shop=${shopDomain}&error=${encodeURIComponent('Failed to connect to Notion')}`);
    }

    const tokenData = await tokenResponse.json() as any;
    console.log('✅ Got Notion access token');

    // Just store OAuth completion and redirect back - user will manually connect database
    console.log(`✅ Notion OAuth completed for shop: ${shopName}`);
    console.log('💡 User will manually connect their database via the UI');
    
    // Redirect back to embedded app - user can now connect their database manually
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    res.redirect(`${appUrl}/app?shop=${shopDomain}&notion_auth=completed`);

  } catch (error) {
    console.error('❌ Error in Notion OAuth callback:', error);
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    res.redirect(`${appUrl}/app?shop=unknown&error=${encodeURIComponent('Notion OAuth failed')}`);
  }
});

/**
 * POST /auth/connect-store
 * Connect a store with a Notion database
 */
router.post('/connect-store', async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers.authorization?.replace('Bearer ', '');
    const { shopName, notionDbId } = req.body;

    if (!sessionId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Session ID required'
      });
    }

    if (!shopName || !notionDbId) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required fields: shopName and notionDbId'
      });
    }

    // Get user from session
    const user = await userStoreService.getUserBySession(sessionId);
    if (!user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired session'
      });
    }

    // Extract database ID from URL if needed
    let cleanDbId = notionDbId;
    if (notionDbId.includes('notion.so/')) {
      const urlParts = notionDbId.split('/');
      cleanDbId = urlParts[urlParts.length - 1].split('?')[0];
    }

    // Validate database ID format
    if (cleanDbId.length < 32 || !/^[a-f0-9-]+$/i.test(cleanDbId)) {
      return res.status(400).json({
        error: 'Invalid Database ID',
        message: 'Notion Database ID format is invalid'
      });
    }

    // Test database access
    try {
      const notionService = new NotionService(process.env.NOTION_TOKEN, cleanDbId);
      const canAccess = await notionService.testConnection();
      
      if (!canAccess) {
        return res.status(400).json({
          error: 'Database Access Error',
          message: 'Cannot access the provided Notion database. Please make sure it is shared with our integration.'
        });
      }
    } catch (notionError) {
      console.error('❌ Database access test failed:', notionError);
      return res.status(400).json({
        error: 'Database Access Error',
        message: 'Could not access the Notion database. Please check the URL and sharing permissions.'
      });
    }

    // Update user's Notion database ID
    const success = await userStoreService.updateUserNotionDb(user.id, cleanDbId);
    if (!success) {
      return res.status(500).json({
        error: 'Database Update Error',
        message: 'Failed to update user database ID'
      });
    }

    // Check if store is already connected
    const usersWithStore = await userStoreService.getAllUsersWithStore(shopName);
    const storeExists = await Promise.all(usersWithStore.map(async ({ user: u }) => u.id === user.id));

    if (!storeExists) {
      await userStoreService.addStoreToUser(
        user.id,
        shopName,
        `${shopName}.myshopify.com`,
        process.env.SHOPIFY_ACCESS_TOKEN || ''
      );
    }

    res.json({
      success: true,
      message: 'Store connected successfully',
      data: {
        shopName,
        notionDbId: cleanDbId
      }
    });

  } catch (error) {
    console.error('❌ Error connecting store:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to connect store'
    });
  }
});

/**
 * POST /auth/manual-connect
 * Manually connect a store to a database (debug endpoint)
 */
router.post('/manual-connect', async (req: Request, res: Response) => {
  try {
    const { shopName, notionDbId, email } = req.body;

    if (!shopName || !notionDbId) {
      return res.status(400).json({
        error: 'Missing required fields: shopName and notionDbId'
      });
    }

    // Create or update user
    let user;
    try {
      user = await userStoreService.getUserByEmail(email || `user-${shopName}@shopify.local`);
    } catch {
      // User doesn't exist, let's try a different approach
      console.log(`⚠️ User not found, will create during store connection`);
      user = null;
    }

    // Update database ID
    await userStoreService.updateUserNotionDb(user.id, notionDbId);

    // Add store connection
    await userStoreService.addStoreToUser(
      user.id,
      shopName,
      `${shopName}.myshopify.com`,
      process.env.SHOPIFY_ACCESS_TOKEN || ''
    );

    console.log(`🔗 Manually connected ${shopName} to database ${notionDbId}`);

    res.json({
      success: true,
      message: 'Store manually connected successfully',
      data: {
        userId: user.id,
        shopName,
        notionDbId
      }
    });

  } catch (error) {
    console.error('❌ Error in manual connect:', error);
    res.status(500).json({
      error: 'Failed to manually connect store',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router; 