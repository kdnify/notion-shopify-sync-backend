import express from 'express';
import { Request, Response } from 'express';
import { userStoreService } from '../services/userStore';
import { ShopifyService } from '../services/shopify';

const router = express.Router();
const shopifyService = new ShopifyService();

/**
 * GET /auth?shop=SHOP_NAME
 * STEP 1: User installs app - immediately redirect to Shopify OAuth
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { shop } = req.query;
    
    if (!shop) {
      return res.status(400).json({ error: 'Missing shop parameter' });
    }

    const shopName = (shop as string).replace('.myshopify.com', '');
    console.log(`🚀 Starting installation for shop: ${shopName}`);

    // Generate Shopify OAuth URL
    const authUrl = shopifyService.generateAuthUrl(shopName, '');
    console.log(`🔄 Redirecting to Shopify OAuth: ${authUrl}`);
    
    res.redirect(authUrl);

  } catch (error) {
    console.error('❌ Error in auth initiation:', error);
    res.status(500).json({ error: 'Failed to start installation' });
  }
});

/**
 * GET /auth/callback
 * STEP 2: Shopify OAuth callback - create user and redirect to Notion OAuth
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    console.log('📥 Shopify OAuth callback received');

    const { shop, code, hmac } = req.query;

    if (!shop || !code || !hmac) {
      return res.status(400).json({ error: 'Missing OAuth parameters' });
    }

    // Verify OAuth callback
    if (!shopifyService.verifyOAuthCallback(req.query)) {
      return res.status(401).json({ error: 'Invalid OAuth callback' });
    }

    const shopName = (shop as string).replace('.myshopify.com', '');
    console.log(`✅ Shopify OAuth verified for: ${shopName}`);

    // Get access token
    const accessToken = await shopifyService.getAccessToken(shopName, code as string);
    const shopInfo = await shopifyService.getShopInfo(shopName, accessToken);

    // Create user
    const userEmail = `${shopName}@shopify.local`;
    const user = await userStoreService.createOrGetUser(userEmail, 'temp-token', 'temp-db');
    
    // Connect store
    await userStoreService.addStoreToUser(user.id, shopName, shopInfo.domain, accessToken);
    
    // Create webhook
    try {
      await shopifyService.createOrderWebhook(shopName, accessToken);
      console.log(`🎯 Webhook created for ${shopName}`);
    } catch (webhookError) {
      console.warn(`⚠️ Webhook creation failed:`, webhookError);
    }

    console.log(`✅ User created: ${user.id} for shop: ${shopName}`);

    // IMMEDIATELY redirect to Notion OAuth
    const notionOAuthUrl = buildNotionOAuthUrl(shopInfo.domain, user.id);
    console.log(`🔄 Redirecting to Notion OAuth: ${notionOAuthUrl}`);
    
    res.redirect(notionOAuthUrl);

  } catch (error) {
    console.error('❌ Shopify OAuth callback error:', error);
    res.status(500).json({ error: 'OAuth callback failed' });
  }
});

/**
 * GET /auth/notion-callback
 * STEP 3: Notion OAuth callback - get token, create database, DONE
 */
router.get('/notion-callback', async (req: Request, res: Response) => {
  try {
    console.log('📥 Notion OAuth callback received');

    const { code, state } = req.query;

    if (!code || !state) {
      return res.status(400).json({ error: 'Missing Notion OAuth parameters' });
    }

    // Parse state
    const stateData = JSON.parse(decodeURIComponent(state as string));
    const { shop, userId } = stateData;
    const shopName = shop.replace('.myshopify.com', '');

    console.log(`🔑 Processing Notion OAuth for user: ${userId}, shop: ${shopName}`);

    // Exchange code for access token
    const tokenData = await exchangeNotionCode(code as string);
    console.log('✅ Got Notion access token');

    // Create personal database from template
    const personalDbId = await createPersonalDatabase(tokenData.access_token, shopName);
    console.log(`✅ Created personal database: ${personalDbId}`);

    // Update user with personal token and database
    await userStoreService.updateUserNotionToken(userId, tokenData.access_token);
    await userStoreService.updateUserNotionDb(userId, personalDbId);

    console.log(`🎉 SETUP COMPLETE for ${shopName}!`);

    // Redirect to success page
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    res.redirect(`${appUrl}/app?shop=${shop}&setup=complete`);

  } catch (error) {
    console.error('❌ Notion OAuth callback error:', error);
    const appUrl = process.env.SHOPIFY_APP_URL || `${req.protocol}://${req.get('host')}`;
    res.redirect(`${appUrl}/app?shop=unknown&error=setup_failed`);
  }
});

/**
 * GET /auth/status?shop=SHOP
 * Check if shop is fully set up
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const { shop } = req.query;
    
    if (!shop) {
      return res.status(400).json({ error: 'Missing shop parameter' });
    }

    const shopName = (shop as string).replace('.myshopify.com', '');
    const usersWithStore = await userStoreService.getAllUsersWithStore(shopName);

    if (usersWithStore.length === 0) {
      return res.json({
        connected: false,
        step: 'install_app',
        message: 'App not installed'
      });
    }

    const { user } = usersWithStore[0];
    
    if (!user.notionDbId || user.notionDbId === 'temp-db') {
      return res.json({
        connected: false,
        step: 'connect_notion',
        message: 'Notion not connected'
      });
    }

    return res.json({
      connected: true,
      step: 'complete',
      message: 'Fully connected',
      data: {
        userId: user.id,
        email: user.email,
        notionDbId: user.notionDbId
      }
    });

  } catch (error) {
    console.error('❌ Status check error:', error);
    res.status(500).json({ error: 'Status check failed' });
  }
});

// Helper functions
function buildNotionOAuthUrl(shop: string, userId: string): string {
  const clientId = process.env.NOTION_OAUTH_CLIENT_ID || '212d872b-594c-80fd-ae95-0037202a219e';
  const redirectUri = 'https://notion-shopify-sync-backend.onrender.com/auth/notion-callback';
  
  const state = encodeURIComponent(JSON.stringify({ shop, userId }));
  
  return `https://api.notion.com/v1/oauth/authorize?` +
    `client_id=${clientId}&` +
    `response_type=code&` +
    `owner=user&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `state=${state}`;
}

async function exchangeNotionCode(code: string): Promise<any> {
  const clientId = process.env.NOTION_OAUTH_CLIENT_ID || '212d872b-594c-80fd-ae95-0037202a219e';
  const clientSecret = process.env.NOTION_OAUTH_CLIENT_SECRET || '';

  const response = await fetch('https://api.notion.com/v1/oauth/token', {
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

  if (!response.ok) {
    throw new Error('Failed to exchange Notion code for token');
  }

  return response.json();
}

async function createPersonalDatabase(accessToken: string, shopName: string): Promise<string> {
  const templateDbId = process.env.NOTION_TEMPLATE_DB_ID || '212e8f5ac14a807fb67ac1887df275d5';
  
  // First, get the template database
  const templateResponse = await fetch(`https://api.notion.com/v1/databases/${templateDbId}`, {
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28'
    }
  });

  if (!templateResponse.ok) {
    throw new Error('Failed to access template database');
  }

  const template = await templateResponse.json() as any;

  // Create new database with user's token
  const createResponse = await fetch('https://api.notion.com/v1/databases', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      parent: { type: 'page_id', page_id: template.parent.page_id },
      title: [{ type: 'text', text: { content: `${shopName} Orders - NotionShopifySync` } }],
      properties: template.properties
    })
  });

  if (!createResponse.ok) {
    throw new Error('Failed to create personal database');
  }

  const newDb = await createResponse.json() as any;
  return newDb.id;
}

export default router; 