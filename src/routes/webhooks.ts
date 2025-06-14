import { Router, Request, Response } from 'express';
import { verifyShopifyWebhook, ShopifyOrder } from '../utils/verifyShopify';
import { NotionService } from '../services/notion';

const router = Router();

// Initialize Notion service
let notionService: NotionService;

try {
  notionService = new NotionService();
} catch (error) {
  console.error('Failed to initialize Notion service:', error);
}

/**
 * POST /webhooks/orders
 * Receives Shopify order creation webhooks and syncs them to Notion
 */
router.post('/orders', async (req: Request, res: Response) => {
  try {
    console.log('📦 Received Shopify webhook');

    // Check if Notion service is initialized
    if (!notionService) {
      console.error('❌ Notion service not initialized');
      return res.status(500).json({
        error: 'Service Configuration Error',
        message: 'Notion service is not properly configured'
      });
    }

    // Get the webhook secret
    const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('❌ Missing SHOPIFY_WEBHOOK_SECRET');
      return res.status(500).json({
        error: 'Configuration Error',
        message: 'Webhook secret not configured'
      });
    }

    // Get the signature from headers
    const shopifySignature = req.headers['x-shopify-hmac-sha256'] as string;
    if (!shopifySignature) {
      console.error('❌ Missing Shopify signature header');
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing x-shopify-hmac-sha256 header'
      });
    }

    // Verify the webhook signature
    const rawBody = req.body as Buffer;
    const isValidSignature = verifyShopifyWebhook(rawBody, shopifySignature, webhookSecret);

    if (!isValidSignature) {
      console.error('❌ Invalid Shopify webhook signature');
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid webhook signature'
      });
    }

    console.log('✅ Webhook signature verified');

    // Parse the JSON payload
    let orderData: ShopifyOrder;
    try {
      orderData = JSON.parse(rawBody.toString());
    } catch (parseError) {
      console.error('❌ Failed to parse webhook payload:', parseError);
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid JSON payload'
      });
    }

    // Validate required order fields
    if (!orderData.id || !orderData.order_number) {
      console.error('❌ Invalid order data - missing required fields');
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required order fields'
      });
    }

    console.log(`📝 Processing order #${orderData.order_number} (ID: ${orderData.id})`);
    console.log(`👤 Customer: ${orderData.customer.first_name} ${orderData.customer.last_name}`);
    console.log(`💰 Total: ${orderData.currency} ${orderData.total_price}`);

    // Create the page in Notion
    const notionPageId = await notionService.createOrderPage(orderData);

    console.log(`🎉 Successfully synced order #${orderData.order_number} to Notion`);

    // Send success response
    res.status(200).json({
      success: true,
      message: 'Order successfully synced to Notion',
      data: {
        orderId: orderData.id,
        orderNumber: orderData.order_number,
        notionPageId: notionPageId
      }
    });

  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    
    // Send error response
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process webhook',
      details: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

/**
 * GET /webhooks/test
 * Test endpoint to verify webhook setup and Notion connection
 */
router.get('/test', async (req: Request, res: Response) => {
  try {
    console.log('🧪 Testing webhook setup...');

    // Check environment variables
    const checks = {
      shopifySecret: !!process.env.SHOPIFY_WEBHOOK_SECRET,
      notionToken: !!process.env.NOTION_TOKEN,
      notionDbId: !!process.env.NOTION_DB_ID,
      notionConnection: false
    };

    // Test Notion connection if service is initialized
    if (notionService) {
      checks.notionConnection = await notionService.testConnection();
    }

    const allChecksPass = Object.values(checks).every(check => check === true);

    res.status(allChecksPass ? 200 : 500).json({
      status: allChecksPass ? 'OK' : 'ERROR',
      message: allChecksPass 
        ? 'All webhook tests passed successfully' 
        : 'Some webhook tests failed',
      checks: checks,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error during webhook test:', error);
    res.status(500).json({
      status: 'ERROR',
      message: 'Failed to run webhook tests',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

export default router; 