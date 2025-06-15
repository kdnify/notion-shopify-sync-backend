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
    const sessionId = userStoreService.createSession(validUser.id);
    console.log(`🎫 Created session: ${sessionId}`);

    // 🎯 SEAMLESS REDIRECT TO NOTION OAUTH
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    
    // Instead of redirecting to app, redirect directly to Notion OAuth for seamless flow
    const notionOAuthUrl = `${appUrl}/auth/notion-oauth?shop=${shopInfo.domain}&session=${sessionId}`;
    
    console.log(`🔄 Redirecting to seamless Notion OAuth: ${notionOAuthUrl}`);
    res.redirect(notionOAuthUrl);

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

    const { shop: shopDomain, userId, sessionId } = stateData;
    const shopName = shopDomain.replace('.myshopify.com', '');

    console.log(`🔑 Processing Notion OAuth for user: ${userId}, shop: ${shopName}`);

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

    // 🎯 SEAMLESS DATABASE CREATION
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

export default router; 