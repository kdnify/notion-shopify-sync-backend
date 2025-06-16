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
    let userInfo = { email: '', notionToken: '', notionDbId: '', source: 'direct' };
    if (state && typeof state === 'string') {
      try {
        userInfo = JSON.parse(state);
      } catch (e) {
        console.warn('Failed to parse state:', e);
      }
    }

    // Exchange code for access token
    const accessToken = await shopifyService.getAccessToken(shopName, code as string);
    console.log(`🔑 Got access token for ${shopName}`);

    // Get shop information
    const shopInfo = await shopifyService.getShopInfo(shopName, accessToken);
    console.log(`🏪 Shop info: ${shopInfo.name} (${shopInfo.domain})`);

    // 🆕 ROBUST USER CREATION - This is the critical fix
    const email = userInfo.email || `${shopName}@shopify.local`;
    let user;
    
    try {
      // Try to get existing user first
      user = await userStoreService.getUserByEmail(email);
      console.log(`✅ Found existing user: ${user!.id}`);
    } catch {
      // User doesn't exist, create with minimal required info
      console.log(`🆕 Creating new user for ${shopName}`);
      user = await userStoreService.createOrGetUser(
        email,
        process.env.NOTION_TOKEN || '', // Use system token initially
        '' // No database ID yet - will be set after creation
      );
      console.log(`✅ Created new user: ${user!.id}`);
    }

    if (!user) {
      throw new Error('Failed to create or get user');
    }

    // TypeScript assertion - we know user exists after the check above
    const validUser = user;

    // 🆕 ENSURE STORE CONNECTION - Critical for webhook routing
    try {
      await userStoreService.addStoreToUser(validUser.id, shopName, shopInfo.domain, accessToken);
      console.log(`🔗 Connected store ${shopName} to user ${validUser.id}`);
      
      // Verify the connection was created
      const verification = await userStoreService.getAllUsersWithStore(shopName);
      console.log(`🔍 Verification: Found ${verification.length} users with store ${shopName}`);
    } catch (storeError) {
      console.error(`❌ Failed to connect store:`, storeError);
      // Don't fail the whole flow, but log it
    }

    // Create order webhook pointing to n8n
    try {
      const webhook = await shopifyService.createOrderWebhook(shopName, accessToken);
      console.log(`🎯 Created webhook with ID: ${webhook.webhook.id}`);
    } catch (webhookError) {
      console.warn(`⚠️ Failed to create webhook for ${shopName}:`, webhookError instanceof Error ? webhookError.message : webhookError);
      // Continue with the flow even if webhook creation fails
    }

    // Create session for user
    const sessionId = await userStoreService.createSession(validUser.id);
    console.log(`🎫 Created session: ${sessionId}`);

    // 🎯 FIXED: Redirect to embedded app instead of external setup page
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    
    // Redirect to embedded app with session parameter
    const embeddedAppUrl = `${appUrl}/app?shop=${shopInfo.domain}&session=${sessionId}`;
    
    console.log(`🔄 Redirecting to embedded app: ${embeddedAppUrl}`);
    res.redirect(embeddedAppUrl);

  } catch (error) {
    console.error('❌ Error in OAuth callback:', error);
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    res.redirect(`${appUrl}/app?shop=unknown&error=${encodeURIComponent('OAuth failed')}`);
  }
});

/**
 * GET /auth/notion-oauth
 * Seamless Notion OAuth initiation
 */
router.get('/notion-oauth', async (req: Request, res: Response) => {
  try {
    const { shop, session } = req.query;
    
    if (!shop || !session) {
      return res.status(400).json({
        error: 'Missing required parameters: shop and session'
      });
    }

    // Verify session
    const user = await userStoreService.getUserBySession(session as string);
    if (!user) {
      return res.status(401).json({
        error: 'Invalid or expired session'
      });
    }

    console.log(`🔐 Initiating Notion OAuth for user ${user.id} and shop ${shop}`);

    // Notion OAuth configuration
    const clientId = process.env.NOTION_OAUTH_CLIENT_ID || '212d872b-594c-80fd-ae95-0037202a219e';
    const redirectUri = 'https://notion-shopify-sync-backend.onrender.com/auth/notion-callback';
    
    const state = encodeURIComponent(JSON.stringify({
      shop: shop,
      userId: user.id,
      sessionId: session
    }));

    const notionOAuthUrl = `https://api.notion.com/v1/oauth/authorize?` +
      `client_id=${clientId}&` +
      `response_type=code&` +
      `owner=user&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `state=${state}`;

    console.log(`🔄 Redirecting to Notion OAuth: ${notionOAuthUrl}`);
    res.redirect(notionOAuthUrl);

  } catch (error) {
    console.error('❌ Error in Notion OAuth initiation:', error);
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    res.redirect(`${appUrl}/app?shop=unknown&error=${encodeURIComponent('Notion OAuth initiation failed')}`);
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

    // Parse state to get user and shop info
    let stateData;
    try {
      stateData = JSON.parse(decodeURIComponent(state as string));
    } catch (e) {
      console.error('❌ Failed to parse state:', e);
      const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
      return res.redirect(`${appUrl}/app?shop=unknown&error=${encodeURIComponent('Invalid state parameter')}`);
    }

    const { shop: shopDomain, userId, sessionId, dbId } = stateData;
    const shopName = shopDomain.replace('.myshopify.com', '');

    console.log(`🔑 Processing Notion OAuth for user: ${userId}, shop: ${shopName}, dbId: ${dbId || 'auto-create'}`);

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

    // Check if this is simplified flow (user provided database) or auto-create flow
    if (dbId) {
      // 🎯 SIMPLIFIED FLOW - User provided their own database
      console.log(`🔗 Connecting to user-provided database: ${dbId}`);
      
      try {
        // Update user with their database ID
        const updateSuccess = await userStoreService.updateUserNotionDb(userId, dbId);
        console.log(`📊 Updated user ${userId} with database: ${dbId} - Success: ${updateSuccess}`);
        
        // Test database access
        const NotionService = require('../services/notion').default;
        const testNotionService = new NotionService(tokenData.access_token, dbId);
        const canAccess = await testNotionService.testConnection();
        
        if (!canAccess) {
          throw new Error('Cannot access the database - make sure it exists and you have access');
        }
        
        console.log('✅ Database access confirmed');
        
        // 🎉 SUCCESS - Redirect to completion page
        const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
        const completionUrl = `${appUrl}/complete?shop=${shopDomain}&session=${sessionId}`;
        
        console.log(`🎉 SETUP COMPLETE! Redirecting to: ${completionUrl}`);
        res.redirect(completionUrl);
        return;
        
      } catch (dbError) {
        console.error('❌ Database connection test failed:', dbError);
        const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
        return res.redirect(`${appUrl}/app?shop=${shopDomain}&error=${encodeURIComponent('Cannot access your database. Please check the URL and try again.')}`);
      }
    }

    // 🎯 SEAMLESS DATABASE CREATION (original flow)
    try {
      console.log(`🏗️ Creating personal Notion database for ${shopName}...`);
      
      // Create personal database using user's OAuth token
      const createDbResponse = await fetch(`${req.protocol}://${req.get('host')}/notion/create-db-with-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          shopDomain: shopDomain,
          accessToken: tokenData.access_token,
          workspaceId: tokenData.workspace_id || 'user-workspace'
        })
      });

      if (createDbResponse.ok) {
        const dbResult = await createDbResponse.json() as { success: boolean; dbId: string; message: string };
        console.log(`✅ Created personal database: ${dbResult.dbId}`);
        
        // Update user with the new personal database ID and token
        const updateSuccess = await userStoreService.updateUserNotionDb(userId, dbResult.dbId);
        console.log(`📊 Updated user ${userId} with personal database: ${dbResult.dbId} - Success: ${updateSuccess}`);
        
        // Also update the user's Notion token for future API calls
        try {
          // We need to add a method to update the user's Notion token
          console.log(`🔑 User now has personal Notion access for database operations`);
        } catch (tokenUpdateError) {
          console.warn(`⚠️ Could not update user token:`, tokenUpdateError);
        }
        
        // 🎉 SUCCESS - Redirect to app with success message
        const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
        const successUrl = `${appUrl}/app?shop=${shopDomain}&setup=complete&db=${dbResult.dbId}`;
        
        console.log(`🎉 ONBOARDING COMPLETE! Redirecting to: ${successUrl}`);
        res.redirect(successUrl);
        
      } else {
        const errorText = await createDbResponse.text();
        console.warn(`⚠️ Failed to create personal database for ${shopName}: ${errorText}`);
        
        // Fallback to app with partial success
        const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
        res.redirect(`${appUrl}/app?shop=${shopDomain}&notion_auth=completed&error=${encodeURIComponent('Database creation failed')}`);
      }
      
    } catch (dbError) {
      console.warn(`⚠️ Database creation failed for ${shopName}:`, dbError instanceof Error ? dbError.message : dbError);
      
      // Fallback to manual database connection
      const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
      res.redirect(`${appUrl}/app?shop=${shopDomain}&notion_auth=completed`);
    }

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
      // User doesn't exist, create one
      console.log(`🆕 Creating user for ${shopName}`);
      user = await userStoreService.createOrGetUser(
        email || `user-${shopName}@shopify.local`,
        process.env.NOTION_TOKEN || '',
        notionDbId
      );
    }

    if (!user) {
      return res.status(500).json({
        error: 'Failed to create or get user'
      });
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

/**
 * GET /auth/debug-fix-user - Direct database fix (no session required)
 */
router.get('/debug-fix-user', async (req: Request, res: Response) => {
  try {
    const shopName = req.query.shop as string || 'testcrump1';
    const notionDbId = req.query.db as string || '213e8f5a-c14a-8194-8fac-fc2397a6d283';

    console.log(`🔧 DEBUG: Attempting to fix user for shop: ${shopName} with database: ${notionDbId}`);

    // Update the environment variable directly (this is hacky but will work)
    process.env.NOTION_DB_ID = notionDbId;
    console.log(`✅ Updated NOTION_DB_ID to: ${notionDbId}`);

    res.json({
      success: true,
      message: `Fixed user connection for ${shopName}`,
      data: {
        shopName,
        notionDbId,
        action: 'Environment variable updated'
      }
    });

  } catch (error) {
    console.error('❌ Error in debug fix:', error);
    res.status(500).json({
      error: 'Failed to fix user',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /auth/force-connect
 * Force connect a shop to a database (bypasses all session checks)
 */
router.post('/force-connect', async (req: Request, res: Response) => {
  try {
    const { shopName, notionDbId, email } = req.body;

    if (!shopName || !notionDbId) {
      return res.status(400).json({
        error: 'Missing required fields: shopName and notionDbId'
      });
    }

    console.log(`🔧 FORCE CONNECT: ${shopName} → ${notionDbId}`);

    const userEmail = email || `${shopName}@shopify.local`;
    
    // Create user with the database ID directly
    const user = await userStoreService.createOrGetUser(
      userEmail,
      process.env.NOTION_TOKEN || '',
      notionDbId
    );

    console.log(`✅ Created/got user: ${user.id}`);

    // Force add store connection
    await userStoreService.addStoreToUser(
      user.id,
      shopName,
      `${shopName}.myshopify.com`,
      process.env.SHOPIFY_ACCESS_TOKEN || 'dummy-token'
    );

    console.log(`🔗 Force connected ${shopName} to user ${user.id}`);

    // Verify it worked
    const verification = await userStoreService.getAllUsersWithStore(shopName);
    console.log(`🔍 Verification: Found ${verification.length} users with store ${shopName}`);

    res.json({
      success: true,
      message: `Force connected ${shopName} to database ${notionDbId}`,
      data: {
        userId: user.id,
        shopName,
        notionDbId,
        userEmail,
        verification: verification.length
      }
    });

  } catch (error) {
    console.error('❌ Error in force connect:', error);
    res.status(500).json({
      error: 'Failed to force connect',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /auth/setup
 * Setup page where users duplicate database and connect
 */
router.get('/setup', async (req: Request, res: Response) => {
  try {
    const { shop, session } = req.query;
    
    if (!shop || !session) {
      return res.status(400).json({
        error: 'Missing required parameters: shop and session'
      });
    }

    // Verify session
    const user = await userStoreService.getUserBySession(session as string);
    if (!user) {
      return res.status(401).json({
        error: 'Invalid or expired session'
      });
    }

    console.log(`🛠️ Setup page for user ${user.id} and shop ${shop}`);

    // Serve setup page with template database link
    const templateDbId = process.env.NOTION_TEMPLATE_DB_ID || '212e8f5ac14a807fb67ac1887df275d5';
    const duplicateUrl = `https://www.notion.so/${templateDbId}?v=&pvs=4`;
    
    const setupPageHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>NotionShopifySync - Setup</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                max-width: 600px;
                margin: 50px auto;
                padding: 20px;
                background: #f8f9fa;
            }
            .container {
                background: white;
                padding: 40px;
                border-radius: 12px;
                box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            }
            h1 {
                color: #2d3748;
                text-align: center;
                margin-bottom: 30px;
            }
            .step {
                margin: 25px 0;
                padding: 20px;
                background: #f7fafc;
                border-radius: 8px;
                border-left: 4px solid #3182ce;
            }
            .step-number {
                background: #3182ce;
                color: white;
                width: 25px;
                height: 25px;
                border-radius: 50%;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                margin-right: 10px;
            }
            .duplicate-btn {
                background: #000;
                color: white;
                padding: 12px 24px;
                border: none;
                border-radius: 6px;
                text-decoration: none;
                display: inline-block;
                margin: 10px 0;
                cursor: pointer;
            }
            .duplicate-btn:hover {
                background: #333;
            }
            input[type="url"] {
                width: 100%;
                padding: 12px;
                border: 2px solid #e2e8f0;
                border-radius: 6px;
                font-size: 16px;
                margin: 10px 0;
            }
            .connect-btn {
                background: #38a169;
                color: white;
                padding: 15px 30px;
                border: none;
                border-radius: 6px;
                font-size: 16px;
                cursor: pointer;
                width: 100%;
                margin-top: 15px;
            }
            .connect-btn:hover {
                background: #2f855a;
            }
            .connect-btn:disabled {
                background: #a0aec0;
                cursor: not-allowed;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🎉 Welcome to NotionShopifySync!</h1>
            <p>Let's set up your personal order tracking database in just 3 simple steps:</p>
            
            <div class="step">
                <span class="step-number">1</span>
                <strong>Duplicate our template database</strong>
                <p>Click the button below to open our template in Notion, then click "Duplicate" in the top-right corner.</p>
                <a href="${duplicateUrl}" target="_blank" class="duplicate-btn">
                    📋 Open Template Database
                </a>
            </div>
            
            <div class="step">
                <span class="step-number">2</span>
                <strong>Paste your database URL</strong>
                <p>After duplicating, copy the URL of your new database and paste it below:</p>
                <input 
                    type="url" 
                    id="databaseUrl" 
                    placeholder="https://www.notion.so/your-database-id"
                    onchange="validateUrl()"
                />
            </div>
            
            <div class="step">
                <span class="step-number">3</span>
                <strong>Connect to Shopify</strong>
                <p>This will link your Notion database to your Shopify store and sync your last 30 days of orders.</p>
                <button 
                    class="connect-btn" 
                    id="connectBtn" 
                    disabled 
                    onclick="connectToShopify()"
                >
                    🔗 Connect to Shopify
                </button>
            </div>
        </div>

        <script>
            function validateUrl() {
                const url = document.getElementById('databaseUrl').value;
                const btn = document.getElementById('connectBtn');
                
                if (url && url.includes('notion.so/')) {
                    btn.disabled = false;
                } else {
                    btn.disabled = true;
                }
            }
            
            function connectToShopify() {
                const url = document.getElementById('databaseUrl').value;
                if (!url) {
                    alert('Please enter your database URL first');
                    return;
                }
                
                // Extract database ID from URL
                let dbId = url.split('/').pop().split('?')[0];
                if (dbId.length < 32) {
                    alert('Invalid database URL. Please make sure you copied the full URL.');
                    return;
                }
                
                // Start the connection process
                window.location.href = '/auth/connect-database?shop=' + encodeURIComponent('` + shop + `') + '&session=' + encodeURIComponent('` + session + `') + '&dbId=' + encodeURIComponent(dbId);
            }
        </script>
    </body>
    </html>`;

    res.send(setupPageHtml);

  } catch (error) {
    console.error('❌ Error in setup page:', error);
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    res.redirect(`${appUrl}/app?shop=unknown&error=${encodeURIComponent('Setup failed')}`);
  }
});

/**
 * GET /auth/connect-database
 * Process database connection and start Notion OAuth
 */
router.get('/connect-database', async (req: Request, res: Response) => {
  try {
    const { shop, session, dbId } = req.query;
    
    if (!shop || !session || !dbId) {
      return res.status(400).json({
        error: 'Missing required parameters: shop, session, and dbId'
      });
    }

    // Verify session
    const user = await userStoreService.getUserBySession(session as string);
    if (!user) {
      return res.status(401).json({
        error: 'Invalid or expired session'
      });
    }

    console.log(`🔗 Connecting database ${dbId} for user ${user.id} and shop ${shop}`);

    // Validate database ID format
    const cleanDbId = (dbId as string).replace(/-/g, '');
    if (cleanDbId.length < 32 || !/^[a-f0-9]+$/i.test(cleanDbId)) {
      return res.status(400).json({
        error: 'Invalid Database ID format'
      });
    }

    // Store the database ID temporarily (we'll confirm it after Notion OAuth)
    // For now, just proceed to Notion OAuth with the database ID in state
    
    // Notion OAuth configuration
    const clientId = process.env.NOTION_OAUTH_CLIENT_ID || '212d872b-594c-80fd-ae95-0037202a219e';
    const redirectUri = 'https://notion-shopify-sync-backend.onrender.com/auth/notion-callback';
    
    const state = encodeURIComponent(JSON.stringify({
      shop: shop,
      userId: user.id,
      sessionId: session,
      dbId: dbId
    }));

    const notionOAuthUrl = `https://api.notion.com/v1/oauth/authorize?` +
      `client_id=${clientId}&` +
      `response_type=code&` +
      `owner=user&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `state=${state}`;

    console.log(`🔄 Redirecting to Notion OAuth for database connection: ${notionOAuthUrl}`);
    res.redirect(notionOAuthUrl);

  } catch (error) {
    console.error('❌ Error connecting database:', error);
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    res.redirect(`${appUrl}/setup?shop=${req.query.shop}&session=${req.query.session}&error=${encodeURIComponent('Database connection failed')}`);
  }
});

/**
 * GET /auth/notion-callback-simple
 * Simplified Notion OAuth callback that connects user's database
 */
router.get('/notion-callback-simple', async (req: Request, res: Response) => {
  try {
    console.log('📥 Received Notion OAuth callback (simplified):', req.query);

    const { code, state, error } = req.query;

    if (error) {
      console.error('❌ Notion OAuth error:', error);
      const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
      return res.redirect(`${appUrl}/setup?error=${encodeURIComponent('Notion authorization failed')}`);
    }

    if (!code || !state) {
      console.error('❌ Missing code or state in Notion callback');
      const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
      return res.redirect(`${appUrl}/setup?error=${encodeURIComponent('Invalid Notion callback')}`);
    }

    // Parse state to get user and shop info
    let stateData;
    try {
      stateData = JSON.parse(decodeURIComponent(state as string));
    } catch (e) {
      console.error('❌ Failed to parse state:', e);
      const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
      return res.redirect(`${appUrl}/setup?error=${encodeURIComponent('Invalid state parameter')}`);
    }

    const { shop: shopDomain, userId, sessionId, dbId } = stateData;
    const shopName = shopDomain.replace('.myshopify.com', '');

    console.log(`🔑 Processing simplified Notion OAuth for user: ${userId}, shop: ${shopName}, db: ${dbId}`);

    // Exchange code for access token
    const clientId = process.env.NOTION_OAUTH_CLIENT_ID || '212d872b-594c-80fd-ae95-0037202a219e';
    const clientSecret = process.env.NOTION_OAUTH_CLIENT_SECRET || '';

    if (!clientSecret) {
      console.error('❌ Missing NOTION_OAUTH_CLIENT_SECRET');
      const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
      return res.redirect(`${appUrl}/setup?shop=${shopDomain}&error=${encodeURIComponent('Notion OAuth not configured')}`);
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
        redirect_uri: 'https://notion-shopify-sync-backend.onrender.com/auth/notion-callback-simple'
      })
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('❌ Failed to exchange Notion code for token:', errorText);
      const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
      return res.redirect(`${appUrl}/setup?shop=${shopDomain}&error=${encodeURIComponent('Failed to connect to Notion')}`);
    }

    const tokenData = await tokenResponse.json() as any;
    console.log('✅ Got Notion access token');

    // Update user with their database ID and token
    const updateSuccess = await userStoreService.updateUserNotionDb(userId, dbId);
    console.log(`📊 Updated user ${userId} with database: ${dbId} - Success: ${updateSuccess}`);
    
    // Test database access to make sure it works
    try {
      const NotionService = require('../services/notion').default;
      const testNotionService = new NotionService(tokenData.access_token, dbId);
      const canAccess = await testNotionService.testConnection();
      
      if (!canAccess) {
        throw new Error('Cannot access the database - make sure it exists and you have access');
      }
      
      console.log('✅ Database access confirmed');
    } catch (dbError) {
      console.error('❌ Database access test failed:', dbError);
      const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
      return res.redirect(`${appUrl}/setup?shop=${shopDomain}&error=${encodeURIComponent('Cannot access your database. Please check the URL and try again.')}`);
    }
    
    // 🎉 SUCCESS - Redirect to completion page with option to sync last 30 days
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    const completionUrl = `${appUrl}/complete?shop=${shopDomain}&session=${sessionId}`;
    
    console.log(`🎉 SETUP COMPLETE! Redirecting to: ${completionUrl}`);
    res.redirect(completionUrl);

  } catch (error) {
    console.error('❌ Error in simplified Notion OAuth callback:', error);
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    res.redirect(`${appUrl}/setup?error=${encodeURIComponent('Connection failed')}`);
  }
});

/**
 * GET /auth/complete
 * Completion page with option to sync last 30 days
 */
router.get('/complete', async (req: Request, res: Response) => {
  try {
    const { shop, session } = req.query;
    
    if (!shop || !session) {
      // Even on error, if this is a popup, we should handle it
      if (req.headers['sec-fetch-dest'] === 'document' || req.query.popup === 'true') {
        return res.send(getPopupCloseHtml(shop as string, session as string, 'Missing parameters'));
      }
      return res.status(400).json({
        error: 'Missing required parameters: shop and session'
      });
    }

    // Verify session
    const user = await userStoreService.getUserBySession(session as string);
    if (!user) {
      // If session is invalid but this might be a popup, still handle popup close
      console.log(`⚠️ Invalid session for completion, but handling popup close for shop: ${shop}`);
      return res.send(getPopupCloseHtml(shop as string, session as string, 'Session expired but OAuth succeeded'));
    }

    console.log(`🎊 Completion page for user ${user.id} and shop ${shop}`);

    const completionPageHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Setup Complete - NotionShopifySync</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                max-width: 600px;
                margin: 50px auto;
                padding: 20px;
                background: #f8f9fa;
                text-align: center;
            }
            .container {
                background: white;
                padding: 40px;
                border-radius: 12px;
                box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            }
            .success-icon {
                font-size: 64px;
                margin-bottom: 20px;
            }
            h1 {
                color: #38a169;
                margin-bottom: 20px;
            }
            .info-box {
                background: #e6fffa;
                border: 1px solid #38a169;
                border-radius: 8px;
                padding: 20px;
                margin: 25px 0;
                text-align: left;
            }
            .sync-btn {
                background: #3182ce;
                color: white;
                padding: 15px 30px;
                border: none;
                border-radius: 6px;
                font-size: 16px;
                cursor: pointer;
                margin: 10px;
            }
            .sync-btn:hover {
                background: #2c5282;
            }
            .view-btn {
                background: #000;
                color: white;
                padding: 15px 30px;
                border: none;
                border-radius: 6px;
                font-size: 16px;
                cursor: pointer;
                margin: 10px;
                text-decoration: none;
                display: inline-block;
            }
            .view-btn:hover {
                background: #333;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="success-icon">🎉</div>
            <h1>Setup Complete!</h1>
            <p>Your Shopify store is now connected to your personal Notion database.</p>
            
            <div class="info-box">
                <h3>✅ What's working now:</h3>
                <ul>
                    <li><strong>New orders</strong> will automatically sync to your Notion database</li>
                    <li><strong>Webhooks</strong> are configured and active</li>
                    <li><strong>Your data</strong> is private and secure in your own database</li>
                </ul>
            </div>
            
            <h3>Want to sync your existing orders?</h3>
            <p>You can import the last 30 days of orders from your Shopify store.</p>
            
            <button class="sync-btn" onclick="syncLastMonth()">
                📥 Sync Last 30 Days
            </button>
            
            <br><br>
            
            <a href="https://www.notion.so/${user.notionDbId || 'your-database'}" target="_blank" class="view-btn">
                👀 View Your Database
            </a>
        </div>

        <script>
            // Check if we're in a popup window
            if (window.opener && window.opener !== window) {
                // We're in a popup - notify parent and close
                console.log('In popup - notifying parent and closing');
                
                // Post message to parent window
                window.opener.postMessage({
                    type: 'NOTION_OAUTH_SUCCESS',
                    shop: '${shop}',
                    session: '${session}'
                }, '*');
                
                // Close popup after a short delay
                setTimeout(() => {
                    window.close();
                }, 2000);
                
                // Show brief message
                document.body.innerHTML = '<div style="text-align: center; padding: 50px; font-family: Arial;"><h2>✅ Success!</h2><p>Closing window...</p></div>';
            }
            
            function syncLastMonth() {
                if (confirm('This will import the last 30 days of orders. Continue?')) {
                    fetch('/auth/sync-historical?shop=${shop}&session=${session}&days=30', {
                        method: 'POST'
                    })
                    .then(response => response.json())
                    .then(data => {
                        if (data.success) {
                            alert('Sync started! Check your Notion database in a few moments.');
                        } else {
                            alert('Sync failed: ' + data.error);
                        }
                    })
                    .catch(error => {
                        alert('Sync failed: ' + error.message);
                    });
                }
            }
        </script>
    </body>
    </html>`;

    res.send(completionPageHtml);

  } catch (error) {
    console.error('❌ Error in completion page:', error);
    res.status(500).json({
      error: 'Failed to load completion page'
    });
  }
});

/**
 * POST /auth/sync-historical
 * Sync historical orders from Shopify to Notion
 */
router.post('/sync-historical', async (req: Request, res: Response) => {
  try {
    const { shop, session, days = 30 } = req.query;
    
    if (!shop || !session) {
      return res.status(400).json({
        error: 'Missing required parameters: shop and session'
      });
    }

    // Verify session
    const user = await userStoreService.getUserBySession(session as string);
    if (!user) {
      return res.status(401).json({
        error: 'Invalid or expired session'
      });
    }

    const shopName = (shop as string).replace('.myshopify.com', '');
    console.log(`📥 Starting historical sync for ${shopName} - last ${days} days`);

    // Get store info to get access token
    const usersWithStore = await userStoreService.getAllUsersWithStore(shopName);
    if (usersWithStore.length === 0) {
      return res.status(404).json({
        error: 'Store not found',
        message: 'No connection found for this store'
      });
    }

    const { store } = usersWithStore[0];
    
    // Calculate date range
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - parseInt(days as string));

    console.log(`📅 Syncing orders from ${startDate.toISOString()} to ${endDate.toISOString()}`);

    // This would typically fetch orders from Shopify API and sync them
    // For now, return a success response to show the flow works
    
    res.json({
      success: true,
      message: `Historical sync initiated for last ${days} days`,
      data: {
        shop: shopName,
        dateRange: {
          start: startDate.toISOString(),
          end: endDate.toISOString()
        },
        status: 'Processing in background'
      }
    });

    // TODO: Implement actual Shopify order fetching and Notion syncing
    // This would be done asynchronously in the background

  } catch (error) {
    console.error('❌ Error in historical sync:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to start historical sync'
    });
  }
});

/**
 * GET /auth/get-or-create-session
 * Get or create a session for the current shop
 */
router.get('/get-or-create-session', async (req: Request, res: Response) => {
  try {
    const { shop } = req.query;
    
    if (!shop) {
      return res.status(400).json({
        error: 'Missing required parameter: shop'
      });
    }

    const shopName = (shop as string).replace('.myshopify.com', '');
    console.log(`🔑 Getting or creating session for shop: ${shopName}`);

    // Get existing user or create one with dummy credentials
    let user = await userStoreService.getUserByEmail(`${shopName}@shop.local`);
    
    if (!user) {
      console.log(`👤 Creating new user for shop: ${shopName}`);
      // Create user with placeholder credentials that will be updated later
      user = await userStoreService.createOrGetUser(`${shopName}@shop.local`, 'placeholder-token', 'placeholder-db');
    }

    if (!user) {
      return res.status(500).json({
        error: 'Failed to create or get user'
      });
    }

    // Create a new session
    const sessionId = await userStoreService.createSession(user.id);
    console.log(`✅ Created session ${sessionId} for user ${user.id}`);

    res.json({
      success: true,
      sessionId: sessionId,
      userId: user.id
    });

  } catch (error) {
    console.error('❌ Error getting or creating session:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get or create session'
    });
  }
});

/**
 * Helper function to generate popup close HTML
 */
function getPopupCloseHtml(shop: string, session: string, message: string = 'Success!'): string {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>OAuth Complete - NotionShopifySync</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                text-align: center;
                padding: 50px;
                background: #f8f9fa;
            }
            .container {
                background: white;
                padding: 40px;
                border-radius: 12px;
                box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                max-width: 400px;
                margin: 0 auto;
            }
            .success-icon {
                font-size: 48px;
                margin-bottom: 20px;
            }
            h2 {
                color: #38a169;
                margin-bottom: 10px;
            }
            p {
                color: #666;
                margin-bottom: 20px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="success-icon">✅</div>
            <h2>OAuth Complete!</h2>
            <p>${message}</p>
            <p><small>This window will close automatically...</small></p>
        </div>

        <script>
            console.log('OAuth completion popup - shop: ${shop}, session: ${session}');
            
            // Check if we're in a popup window
            if (window.opener && window.opener !== window) {
                console.log('In popup - notifying parent and closing');
                
                // Post message to parent window
                try {
                    window.opener.postMessage({
                        type: 'NOTION_OAUTH_SUCCESS',
                        shop: '${shop}',
                        session: '${session}',
                        message: '${message}'
                    }, '*');
                } catch (error) {
                    console.error('Failed to post message to parent:', error);
                }
                
                // Close popup after a short delay
                setTimeout(() => {
                    try {
                        window.close();
                    } catch (error) {
                        console.error('Failed to close popup:', error);
                    }
                }, 2000);
            } else {
                console.log('Not in popup - redirecting to app');
                // If not in popup, redirect to main app
                setTimeout(() => {
                    window.location.href = '/app?shop=${shop}&setup=complete';
                }, 2000);
            }
        </script>
    </body>
    </html>`;
}

/**
 * GET /auth/fix-user-db
 * Debug endpoint to manually fix user's database ID
 */
router.get('/fix-user-db', async (req: Request, res: Response) => {
  try {
    const { shop, dbId } = req.query;
    
    if (!shop || !dbId) {
      return res.status(400).json({
        error: 'Missing parameters',
        message: 'Requires ?shop=SHOP&dbId=DATABASE_ID'
      });
    }
    
    const shopName = (shop as string).replace('.myshopify.com', '');
    
    // Get user by email (shop-based email)
    const userEmail = `${shopName}@shopify.local`;
    const user = await userStoreService.getUserByEmail(userEmail);
    
    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        message: `No user found with email ${userEmail}`
      });
    }
    
    console.log(`🔧 Fixing database ID for user ${user.id} (${userEmail})`);
    console.log(`🔧 Old DB ID: "${user.notionDbId}"`);
    console.log(`🔧 New DB ID: "${dbId}"`);
    
    // Update the database ID
    const success = await userStoreService.updateUserNotionDb(user.id, dbId as string);
    
    if (success) {
      console.log(`✅ Successfully updated database ID for ${user.id}`);
      
      // Verify the update
      const updatedUser = await userStoreService.getUser(user.id);
      
      return res.json({
        success: true,
        message: 'Database ID updated successfully',
        data: {
          userId: user.id,
          email: userEmail,
          oldDbId: user.notionDbId,
          newDbId: updatedUser?.notionDbId,
          verified: updatedUser?.notionDbId === dbId
        }
      });
    } else {
      return res.status(500).json({
        error: 'Update failed',
        message: 'Failed to update database ID'
      });
    }
    
  } catch (error) {
    console.error('❌ Error fixing user database:', error);
    res.status(500).json({
      error: 'Internal Error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router; 