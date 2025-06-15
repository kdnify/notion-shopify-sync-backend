import { Router, Request, Response } from 'express';
import { verifyShopifyWebhook, ShopifyOrder } from '../utils/verifyShopify';
import { NotionService } from '../services/notion';
import { userStoreService } from '../services/userStore';

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
    console.log(`👤 Customer: ${orderData.customer?.first_name} ${orderData.customer?.last_name}`);
    console.log(`💰 Total: ${orderData.currency} ${orderData.total_price}`);

    // Extract shop name from order data or headers
    const shopDomain = req.headers['x-shopify-shop-domain'] as string || 
                      'unknown-shop';
    const shopName = shopDomain.replace('.myshopify.com', '');

    console.log(`🏪 Processing order for shop: ${shopName}`);

    // Find all users who have this store connected
    const usersWithStore = userStoreService.getAllUsersWithStore(shopName);
    
    if (usersWithStore.length === 0) {
      console.warn(`⚠️ No users found with store ${shopName} connected`);
      // Still process with default Notion service for backward compatibility
      if (notionService) {
        const notionPageId = await notionService.createOrderPage(orderData);
        return res.status(200).json({
          success: true,
          message: 'Order synced to default Notion database',
          data: {
            orderId: orderData.id,
            orderNumber: orderData.order_number,
            notionPageId: notionPageId,
            syncedToUsers: 0
          }
        });
      } else {
        return res.status(404).json({
          error: 'No Configuration Found',
          message: 'No users have this store connected and no default configuration available'
        });
      }
    }

    // Sync to all users' Notion databases
    const syncResults = [];
    for (const { user, store } of usersWithStore) {
      try {
        console.log(`📊 Syncing to user ${user.email} (${user.id})`);
        
        // Create Notion service for this user
        const userNotionService = new NotionService(user.notionToken, user.notionDbId);
        
        // Create the page in user's Notion database
        const notionPageId = await userNotionService.createOrderPage(orderData);
        
        syncResults.push({
          userId: user.id,
          userEmail: user.email,
          notionPageId: notionPageId,
          success: true
        });
        
        console.log(`✅ Synced to ${user.email}'s Notion database`);
        
      } catch (userError) {
        console.error(`❌ Failed to sync to user ${user.email}:`, userError);
        syncResults.push({
          userId: user.id,
          userEmail: user.email,
          success: false,
          error: userError instanceof Error ? userError.message : String(userError)
        });
      }
    }

    const successfulSyncs = syncResults.filter(r => r.success).length;
    console.log(`🎉 Successfully synced order #${orderData.order_number} to ${successfulSyncs}/${syncResults.length} users`);

    // Send success response
    res.status(200).json({
      success: true,
      message: `Order successfully synced to ${successfulSyncs} Notion database(s)`,
      data: {
        orderId: orderData.id,
        orderNumber: orderData.order_number,
        shopName: shopName,
        syncedToUsers: successfulSyncs,
        totalUsers: syncResults.length,
        syncResults: syncResults
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

/**
 * POST /webhooks/sync-to-notion
 * Endpoint for n8n to sync processed order data to user's Notion database
 * This bypasses the need for n8n to have Notion credentials
 */
router.post('/sync-to-notion', async (req: Request, res: Response) => {
  try {
    const { shopDomain, orderData } = req.body;

    if (!shopDomain || !orderData) {
      return res.status(400).json({
        error: 'Missing required fields: shopDomain and orderData'
      });
    }

    console.log(`🔄 Syncing order to Notion for shop: ${shopDomain}`);

    // Extract shop name from domain
    const shopName = shopDomain.replace('.myshopify.com', '');

    // Find users with this store
    const usersWithStore = userStoreService.getAllUsersWithStore(shopName);
    
    if (usersWithStore.length === 0) {
      console.warn(`⚠️ No users found for shop: ${shopName}`);
      return res.status(404).json({
        error: 'No users found for this shop'
      });
    }

    const results = [];

    // Sync to each user's personal Notion database
    for (const { user } of usersWithStore) {
      try {
        console.log(`📝 Creating Notion page for user ${user.id} with DB: ${user.notionDbId}`);

        // Use user's personal database and token
        const notionService = new NotionService(user.notionToken, user.notionDbId);
        
        // Create order page in user's personal database
        const pageId = await notionService.createOrderPage(orderData);
        
        results.push({
          userId: user.id,
          pageId: pageId,
          success: true
        });

        console.log(`✅ Successfully synced order to Notion for user ${user.id}`);

      } catch (userError) {
        console.error(`❌ Failed to sync for user ${user.id}:`, userError);
        results.push({
          userId: user.id,
          success: false,
          error: userError instanceof Error ? userError.message : 'Unknown error'
        });
      }
    }

    // Return results
    const successCount = results.filter(r => r.success).length;
    const totalCount = results.length;

    res.json({
      success: true,
      message: `Synced to ${successCount}/${totalCount} user databases`,
      shopDomain,
      results
    });

  } catch (error) {
    console.error('❌ Error in sync-to-notion endpoint:', error);
    res.status(500).json({
      error: 'Failed to sync to Notion',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /webhooks/n8n-orders
 * Endpoint specifically for n8n processed order data
 * Handles the formatted data from n8n code node
 */
router.post('/n8n-orders', async (req: Request, res: Response) => {
  try {
    console.log('📦 Received n8n processed order data');

    const orderData = req.body;
    
    // Handle both single order and array format
    const orders = Array.isArray(orderData) ? orderData : [orderData];
    
    if (orders.length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'No order data provided'
      });
    }

    const results = [];
    
    for (const order of orders) {
      // Validate required fields from n8n format
      if (!order.orderId || !order.shopDomain) {
        console.error('❌ Invalid order data - missing required fields:', order);
        results.push({
          orderId: order.orderId || 'unknown',
          success: false,
          error: 'Missing required fields: orderId or shopDomain'
        });
        continue;
      }

      console.log(`📝 Processing order #${order.orderNumber} (ID: ${order.orderId})`);
      console.log(`👤 Customer: ${order.customerName}`);
      console.log(`💰 Total: ${order.currency} ${order.totalPrice}`);

      // Extract shop name from domain
      const shopName = order.shopDomain.replace('.myshopify.com', '');
      console.log(`🏪 Processing order for shop: ${shopName}`);

      // Find all users who have this store connected
      const usersWithStore = userStoreService.getAllUsersWithStore(shopName);
      
      if (usersWithStore.length === 0) {
        console.warn(`⚠️ No users found with store ${shopName} connected`);
        results.push({
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          success: false,
          error: 'No users found with this store connected'
        });
        continue;
      }

      // Convert n8n format to Shopify format for Notion service
      const shopifyFormatOrder = {
        id: parseInt(order.orderId),
        order_number: order.orderNumber,
        name: order.orderName,
        email: order.customerEmail !== 'no-email@manual-order.com' ? order.customerEmail : undefined,
        created_at: order.createdAt,
        updated_at: order.updatedAt,
        cancelled_at: null,
        closed_at: null,
        processed_at: order.createdAt,
        customer: {
          first_name: order.hasCustomer ? order.customerName.split(' ')[0] : 'Manual Order',
          last_name: order.hasCustomer ? order.customerName.split(' ').slice(1).join(' ') : 'No Customer',
          email: order.customerEmail !== 'no-email@manual-order.com' ? order.customerEmail : undefined
        },
        billing_address: null,
        shipping_address: order.shippingAddress !== 'No Address' ? { 
          address1: order.shippingAddress 
        } : null,
        currency: order.currency,
        total_price: order.totalPrice.toString(),
        subtotal_price: order.subtotalPrice.toString(),
        total_tax: order.totalTax.toString(),
        line_items: [{
          title: order.lineItems,
          quantity: 1,
          price: order.totalPrice.toString()
        }],
        fulfillment_status: order.orderStatus.toLowerCase(),
        financial_status: order.paymentStatus,
        tags: order.tags,
        note: order.note,
        gateway: 'shopify',
        test: order.isTest,
        order_status_url: order.shopifyAdminLink
      };

      // Sync to all users' Notion databases
      const syncResults = [];
      for (const { user, store } of usersWithStore) {
        try {
          console.log(`📊 Syncing to user ${user.email} (${user.id})`);
          
          // Create Notion service for this user
          const userNotionService = new NotionService(user.notionToken, user.notionDbId);
          
          // Create the page in user's Notion database
          const notionPageId = await userNotionService.createOrderPage(shopifyFormatOrder as any);
          
          syncResults.push({
            userId: user.id,
            userEmail: user.email,
            notionPageId: notionPageId,
            success: true
          });
          
          console.log(`✅ Synced to ${user.email}'s Notion database`);
          
        } catch (userError) {
          console.error(`❌ Failed to sync to user ${user.email}:`, userError);
          syncResults.push({
            userId: user.id,
            userEmail: user.email,
            success: false,
            error: userError instanceof Error ? userError.message : String(userError)
          });
        }
      }

      const successfulSyncs = syncResults.filter(r => r.success).length;
      console.log(`🎉 Successfully synced order #${order.orderNumber} to ${successfulSyncs}/${syncResults.length} users`);

      results.push({
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        shopName: shopName,
        syncedToUsers: successfulSyncs,
        totalUsers: syncResults.length,
        syncResults: syncResults,
        success: successfulSyncs > 0
      });
    }

    const totalSuccessful = results.filter(r => r.success).length;
    
    // Send success response
    res.status(200).json({
      success: totalSuccessful > 0,
      message: `Successfully processed ${totalSuccessful}/${results.length} orders`,
      data: {
        processedOrders: results.length,
        successfulSyncs: totalSuccessful,
        results: results
      }
    });

  } catch (error) {
    console.error('❌ Error processing n8n webhook:', error);
    
    // Send error response
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process n8n webhook',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router; 