import { Router, Request, Response } from 'express';
import { ShopifyService } from '../services/shopify';

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
 */
router.get('/', (req: Request, res: Response) => {
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

    // Clean shop name (remove .myshopify.com if present)
    const shopName = shop.replace('.myshopify.com', '');
    
    // Generate OAuth URL
    const authUrl = shopifyService.generateAuthUrl(shopName);
    
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

    // Exchange code for access token
    const accessToken = await shopifyService.getAccessToken(shopName, code as string);
    console.log(`🔑 Got access token for ${shopName}`);

    // Get shop information
    const shopInfo = await shopifyService.getShopInfo(shopName, accessToken);
    console.log(`🏪 Shop info: ${shopInfo.name} (${shopInfo.domain})`);

    // Create order webhook
    const webhook = await shopifyService.createOrderWebhook(shopName, accessToken);
    console.log(`🎯 Created webhook with ID: ${webhook.webhook.id}`);

    // Success response - in a real app you'd store the access token securely
    res.status(200).json({
      success: true,
      message: 'App installed successfully!',
      data: {
        shop: shopName,
        shopName: shopInfo.name,
        domain: shopInfo.domain,
        webhook: {
          id: webhook.webhook.id,
          topic: webhook.webhook.topic,
          address: webhook.webhook.address
        }
      }
    });

    console.log(`🎉 Successfully installed app for ${shopName}`);

  } catch (error) {
    console.error('❌ Error in OAuth callback:', error);
    console.error('❌ Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to complete OAuth flow',
      details: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.message : String(error)) : undefined
    });
  }
});

/**
 * GET /auth/install
 * Installation page with JavaScript-based shop input (no form submission)
 */
router.get('/install', (req: Request, res: Response) => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Install NotionSync</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; }
            .form-group { margin-bottom: 20px; }
            input { padding: 10px; width: 100%; border: 1px solid #ddd; border-radius: 4px; }
            button { background: #5865f2; color: white; padding: 12px 24px; border: none; border-radius: 4px; cursor: pointer; }
            button:hover { background: #4752c4; }
            .info { background: #f0f8ff; padding: 15px; border-radius: 4px; margin-bottom: 20px; }
            .direct-link { background: #e8f5e8; padding: 15px; border-radius: 4px; margin-top: 20px; }
            .direct-link a { color: #2d5a2d; text-decoration: none; font-weight: bold; }
        </style>
    </head>
    <body>
        <h1>Install NotionSync</h1>
        <div class="info">
            <p>This app will sync your Shopify orders to Notion automatically.</p>
            <p>Enter your shop domain below to begin installation.</p>
        </div>
        
        <div class="form-group">
            <label for="shop">Shop Domain:</label>
            <input type="text" id="shop" placeholder="your-shop-name" required>
            <small>Enter just the shop name (without .myshopify.com)</small>
        </div>
        <button onclick="installApp()">Install App</button>
        
        <div class="direct-link">
            <p><strong>Quick Install:</strong> If you know your shop name, you can also use this direct link format:</p>
            <p><code>https://notion-shopify-sync-backend.onrender.com/auth?shop=YOUR_SHOP_NAME</code></p>
        </div>

        <script>
            function installApp() {
                const shopInput = document.getElementById('shop');
                const shop = shopInput.value.trim();
                
                if (!shop) {
                    alert('Please enter your shop name');
                    return;
                }
                
                // Clean shop name (remove .myshopify.com if present)
                const cleanShop = shop.replace('.myshopify.com', '');
                
                // Redirect directly to OAuth (no form submission)
                window.location.href = '/auth?shop=' + encodeURIComponent(cleanShop);
            }
            
            // Allow Enter key to trigger installation
            document.getElementById('shop').addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    installApp();
                }
            });
        </script>
    </body>
    </html>
  `;
  
  res.send(html);
});



export default router; 