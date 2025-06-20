import { Router, Request, Response } from 'express';
import { verifyShopifyWebhook, ShopifyOrder } from '../utils/verifyShopify';
import { NotionService } from '../services/notion';
import { userStoreService } from '../services/userStore';
import { shopNotionStore } from '../services/shopNotionStore';

const router = Router();

// Initialize Notion service
let notionService: NotionService;

try {
  console.log('🔧 Initializing webhook service...');
  console.log('📋 NOTION_TOKEN exists:', !!process.env.NOTION_TOKEN);
  console.log('📋 NOTION_TEMPLATE_DB_ID exists:', !!process.env.NOTION_TEMPLATE_DB_ID);
  
  notionService = new NotionService();
  console.log('✅ Notion service initialized successfully');
} catch (error) {
  console.error('❌ Failed to initialize Notion service:', error);
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
    const usersWithStore = await userStoreService.getAllUsersWithStore(shopName);
    
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
        notionTemplateDbId: !!process.env.NOTION_TEMPLATE_DB_ID,
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
    const usersWithStore = await userStoreService.getAllUsersWithStore(shopName);
    
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
    console.log('📋 Raw request body:', JSON.stringify(req.body, null, 2));
    console.log('📋 Request headers:', JSON.stringify(req.headers, null, 2));
    console.log('📋 Body type:', typeof req.body);
    console.log('📋 Body constructor:', req.body?.constructor?.name);

    const orderData = req.body;
    
    // Handle both single order and array format
    const orders = Array.isArray(orderData) ? orderData : [orderData];
    
    console.log('📊 Processing orders:', orders.length);
    console.log('📋 First order data:', JSON.stringify(orders[0], null, 2));
    
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
      const usersWithStore = await userStoreService.getAllUsersWithStore(shopName);
      
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

/**
 * POST /webhooks/n8n-simple
 * Smart endpoint that routes n8n data to shop-specific Notion databases
 * Falls back to default database if no shop-specific config found
 */
router.post('/n8n-simple', async (req: Request, res: Response) => {
  try {
    console.log('📦 Received n8n order for smart processing');
    
    // Handle both Buffer (from raw body parser) and parsed JSON
    let orderData;
    if (Buffer.isBuffer(req.body)) {
      console.log('📋 Parsing Buffer data...');
      const jsonString = req.body.toString('utf8');
      console.log('📋 JSON string:', jsonString);
      orderData = JSON.parse(jsonString);
    } else {
      console.log('📋 Using parsed JSON data...');
      orderData = req.body;
    }
    
    console.log('📋 Processed order data:', JSON.stringify(orderData, null, 2));
    
    // Handle both single order and array format
    const orders = Array.isArray(orderData) ? orderData : [orderData];
    
    if (orders.length === 0) {
      return res.status(400).json({
        error: 'No order data provided'
      });
    }

    const results = [];
    
    for (const order of orders) {
      // Extract shop domain for multi-shop support (outside try block for scope)
      let cleanShopDomain = 'testcrump1.myshopify.com'; // Default to your test shop
      
      try {
        console.log(`📝 Processing order: ${order.orderNumber || 'unknown'}`);
        console.log(`📋 Order data:`, JSON.stringify(order, null, 2));
        
        // Debug the key fields we're having issues with
        console.log(`🔍 Key field debugging:`);
        console.log(`  - orderNumber: ${order.orderNumber} (type: ${typeof order.orderNumber})`);
        console.log(`  - orderName: ${order.orderName}`);
        console.log(`  - createdAt: ${order.createdAt}`);
        console.log(`  - shippingAddress: ${order.shippingAddress}`);
        console.log(`  - note: ${order.note}`);
        console.log(`  - shopDomain: ${order.shopDomain}`);
        console.log(`  - customerName: ${order.customerName}`);
        console.log(`  - customerEmail: ${order.customerEmail}`);
        
        // Extract shop domain from order data (your n8n workflow sends this as shopDomain)
        let shopDomain = order.shopDomain || order.shop || order.storeName;
        if (!shopDomain) {
          console.warn('⚠️ No shop domain found in order data, using default configuration');
          console.log('🔍 Available order fields:', Object.keys(order));
        }
        
        console.log(`🏪 Shop domain extracted: ${shopDomain || 'none'}`);
        
        // Set the clean shop domain
        cleanShopDomain = shopDomain || 'testcrump1.myshopify.com';
        console.log(`🏪 Processing order for shop: ${cleanShopDomain}`);

        // Convert n8n format to Shopify format for Notion service
        // Your n8n workflow sends excellent data - just need to map it properly
        const shopifyFormatOrder = {
          id: parseInt(order.orderId) || parseInt(order.rawOrderId) || 0,
          order_number: order.orderNumber || 0,
          name: order.orderName || '#' + (order.orderNumber || 'Unknown'),
          email: order.customerEmail !== 'no-email@manual-order.com' ? order.customerEmail : undefined,
          created_at: order.createdAt,
          updated_at: order.updatedAt || order.createdAt,
          cancelled_at: null,
          closed_at: null,
          processed_at: order.createdAt,
          customer: {
            id: parseInt(order.orderId) || 0,
            first_name: order.customerName && order.customerName !== 'Manual Order - No Customer' && order.customerName !== 'Unknown Customer'
              ? order.customerName.split(' ')[0] 
              : 'Manual Order',
            last_name: order.customerName && order.customerName !== 'Manual Order - No Customer' && order.customerName !== 'Unknown Customer'
              ? order.customerName.split(' ').slice(1).join(' ') || 'Customer'
              : 'No Customer',
            email: order.customerEmail || undefined,
            phone: order.customerPhone !== 'No Phone' ? order.customerPhone : null
          },
          billing_address: null,
          shipping_address: order.shippingAddress && order.shippingAddress !== 'No Address' ? { 
            first_name: order.customerName ? order.customerName.split(' ')[0] : '',
            last_name: order.customerName ? order.customerName.split(' ').slice(1).join(' ') : '',
            address1: order.shippingAddress,
            address2: null,
            city: '',
            province: '',
            country: '',
            zip: '',
            phone: order.customerPhone !== 'No Phone' ? order.customerPhone : null
          } : null,
          currency: order.currency || 'GBP',
          total_price: (order.totalPrice || 0).toString(),
          subtotal_price: (order.subtotalPrice || 0).toString(),
          total_tax: (order.totalTax || 0).toString(),
          line_items: [{
            id: parseInt(order.orderId) || 0,
            title: order.lineItems || 'Order Items',
            quantity: 1,
            price: (order.totalPrice || 0).toString(),
            variant_title: null,
            product_id: 0,
            variant_id: 0
          }],
          // Convert capitalized status to lowercase for Notion
          fulfillment_status: order.orderStatus ? order.orderStatus.toLowerCase() : 'unfulfilled',
          financial_status: order.paymentStatus ? order.paymentStatus.toLowerCase() : 'pending',
          tags: order.tags || '',
          note: order.note || '',
          gateway: 'shopify',
          test: order.isTest || false,
          order_status_url: order.shopifyAdminLink || '',
          // Additional fields from your n8n workflow
          confirmation_number: order.confirmationNumber || '',
          source_name: order.orderSource || 'web'
        };

        let notionPageId: string;
        let targetDatabase = 'default';

        // Try to find shop-specific configuration
        const shopConfig = shopNotionStore.getConfig(cleanShopDomain);
        if (shopConfig) {
          console.log(`🎯 Found shop-specific config for: ${cleanShopDomain}`);
          console.log(`📊 Using database: ${shopConfig.notionDbId}`);
          
          // Use shop-specific Notion service
          const shopNotionService = new NotionService(shopConfig.notionToken, shopConfig.notionDbId);
          notionPageId = await shopNotionService.createOrderPage(shopifyFormatOrder as any);
          targetDatabase = shopConfig.notionDbId;
          
          console.log(`✅ Synced order #${order.orderNumber} to shop-specific database`);
        } else {
          console.log(`⚠️ No shop-specific config found for: ${cleanShopDomain}, using default`);
          
          // Fall back to default Notion service
          if (!notionService) {
            throw new Error('No default Notion service available and no shop-specific config found');
          }
          
          notionPageId = await notionService.createOrderPage(shopifyFormatOrder as any);
          console.log(`✅ Synced order #${order.orderNumber} to default database`);
        }
        
        results.push({
          orderId: order.orderId || order.rawOrderId,
          orderNumber: order.orderNumber,
          shopDomain: cleanShopDomain,
          success: true,
          notionPageId: notionPageId,
          targetDatabase: targetDatabase,
          message: shopNotionStore.hasConfig(cleanShopDomain) 
            ? 'Successfully synced to shop-specific database'
            : 'Successfully synced to default database'
        });
        
      } catch (orderError) {
        console.error(`❌ Failed to process order:`, orderError);
        results.push({
          orderId: order.orderId || order.rawOrderId || 'unknown',
          orderNumber: order.orderNumber || 'unknown',
          shopDomain: cleanShopDomain || 'unknown',
          success: false,
          error: orderError instanceof Error ? orderError.message : String(orderError)
        });
      }
    }

    const successfulSyncs = results.filter(r => r.success).length;
    const shopSpecificSyncs = results.filter(r => r.success && r.targetDatabase !== 'default').length;
    
    res.json({
      success: successfulSyncs > 0,
      message: `Successfully processed ${successfulSyncs}/${results.length} orders (${shopSpecificSyncs} to shop-specific databases, ${successfulSyncs - shopSpecificSyncs} to default)`,
      data: {
        processedOrders: results.length,
        successfulSyncs: successfulSyncs,
        shopSpecificSyncs: shopSpecificSyncs,
        defaultSyncs: successfulSyncs - shopSpecificSyncs,
        results: results
      }
    });

  } catch (error) {
    console.error('❌ Error in n8n-simple endpoint:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process order',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * GET /webhooks/debug
 * Debug endpoint to check current configuration
 */
router.get('/debug', async (req: Request, res: Response) => {
  try {
    console.log('🔍 Debug endpoint called');

    const config = {
      notionToken: process.env.NOTION_TOKEN ? '***' + process.env.NOTION_TOKEN.slice(-4) : 'NOT SET',
      notionTemplateDbId: process.env.NOTION_TEMPLATE_DB_ID ? 'SET' : 'NOT SET',
      shopifySecret: process.env.SHOPIFY_WEBHOOK_SECRET ? 'SET' : 'NOT SET',
      nodeEnv: process.env.NODE_ENV || 'NOT SET'
    };

    // Test Notion connection if service is initialized
    let notionTest = null;
    if (notionService) {
      try {
        const database = await notionService.testConnection();
        notionTest = { success: database, message: 'Connection tested' };
      } catch (error) {
        notionTest = { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }

    res.json({
      status: 'DEBUG',
      timestamp: new Date().toISOString(),
      config: config,
      notionTest: notionTest,
      message: 'Debug information retrieved successfully'
    });

  } catch (error) {
    console.error('❌ Error in debug endpoint:', error);
    res.status(500).json({
      status: 'ERROR',
      message: 'Failed to retrieve debug information',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /webhooks/test-create
 * Test endpoint to create a simple page with obvious content
 */
router.post('/test-create', async (req: Request, res: Response) => {
  try {
    console.log('🧪 Test create endpoint called');

    if (!notionService) {
      return res.status(500).json({
        error: 'Notion service not initialized'
      });
    }

    // Create a test order with obvious content
    const testOrder = {
      id: 999999,
      order_number: 999999,
      name: '#999999 - TEST ORDER - DELETE ME',
      email: 'test@example.com',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      total_price: '123.45',
      subtotal_price: '100.00',
      total_tax: '23.45',
      currency: 'USD',
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
      customer: {
        id: 999999,
        first_name: 'TEST',
        last_name: 'CUSTOMER',
        email: 'test@example.com',
        phone: null
      },
      shipping_address: {
        first_name: 'TEST',
        last_name: 'CUSTOMER',
        address1: '123 Test Street',
        address2: null,
        city: 'Test City',
        province: 'Test State',
        country: 'Test Country',
        zip: '12345',
        phone: null
      },
      line_items: [{
        id: 999999,
        title: 'TEST PRODUCT - PLEASE DELETE',
        quantity: 1,
        price: '100.00',
        variant_title: null,
        product_id: 999999,
        variant_id: 999999
      }],
      note: 'This is a test order created by the debug endpoint. Please delete this entry.',
      order_status_url: 'https://test.example.com/orders/999999'
    };

    console.log('🧪 Creating test order with obvious content');
    const pageId = await notionService.createOrderPage(testOrder as any);

    res.json({
      success: true,
      message: 'Test order created successfully',
      data: {
        pageId: pageId,
        testOrder: {
          orderNumber: testOrder.order_number,
          customerName: `${testOrder.customer.first_name} ${testOrder.customer.last_name}`,
          totalPrice: testOrder.total_price,
          status: testOrder.fulfillment_status
        },
        instructions: 'Look for order #999999 with customer "TEST CUSTOMER" in your Notion database'
      }
    });

  } catch (error) {
    console.error('❌ Error in test-create endpoint:', error);
    res.status(500).json({
      error: 'Failed to create test order',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /webhooks/inspect-db?dbId=DATABASE_ID
 * Inspect the database structure and recent pages
 */
router.get('/inspect-db', async (req: Request, res: Response) => {
  try {
    console.log('🔍 Database inspection endpoint called');

    const { dbId } = req.query;
    
    if (!dbId) {
      return res.status(400).json({
        error: 'Missing database ID',
        message: 'Please provide ?dbId=DATABASE_ID parameter'
      });
    }

    if (!notionService) {
      return res.status(500).json({
        error: 'Notion service not initialized'
      });
    }

    console.log(`🔍 Inspecting database: ${dbId}`);

    // Get database info
    const database = await notionService['notion'].databases.retrieve({
      database_id: dbId as string,
    });

    // Get recent pages from the database
    const pages = await notionService['notion'].databases.query({
      database_id: dbId as string,
      sorts: [
        {
          timestamp: 'created_time',
          direction: 'descending'
        }
      ],
      page_size: 10
    });

    // Extract database title
    let dbTitle = 'Unknown Database';
    if (database && 'title' in database && Array.isArray(database.title) && database.title.length > 0) {
      dbTitle = database.title[0].plain_text || 'Unknown Database';
    }

    // Extract property info
    const properties = Object.entries(database.properties as any).map(([name, prop]: [string, any]) => ({
      name,
      type: prop.type,
      id: prop.id
    }));

    // Extract page info
    const pageInfo = pages.results.map((page: any) => {
      const props: any = {};
      Object.entries(page.properties).forEach(([key, value]: [string, any]) => {
        if (value.type === 'title' && value.title.length > 0) {
          props[key] = value.title[0].plain_text;
        } else if (value.type === 'rich_text' && value.rich_text.length > 0) {
          props[key] = value.rich_text[0].plain_text;
        } else if (value.type === 'number') {
          props[key] = value.number;
        } else if (value.type === 'select' && value.select) {
          props[key] = value.select.name;
        } else if (value.type === 'date' && value.date) {
          props[key] = value.date.start;
        }
      });
      
      return {
        id: page.id,
        created_time: page.created_time,
        last_edited_time: page.last_edited_time,
        properties: props
      };
    });

    res.json({
      success: true,
      database: {
        id: dbId,
        title: dbTitle,
        properties: properties,
        totalPages: pages.results.length,
        recentPages: pageInfo
      },
      message: 'Database inspection completed'
    });

  } catch (error) {
    console.error('❌ Error inspecting database:', error);
    res.status(500).json({
      error: 'Failed to inspect database',
      details: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
  }
});

/**
 * POST /webhooks/debug-n8n
 * Debug endpoint to test n8n data reception
 */
router.post('/debug-n8n', async (req: Request, res: Response) => {
  try {
    console.log('🐛 Debug endpoint called');
    console.log('📋 Body:', JSON.stringify(req.body, null, 2));
    console.log('📋 Headers:', JSON.stringify(req.headers, null, 2));
    
    const data = req.body;
    
    res.json({
      success: true,
      message: 'Debug data received',
      data: {
        bodyType: typeof data,
        bodyConstructor: data?.constructor?.name,
        hasOrderId: !!data.orderId,
        hasShopDomain: !!data.shopDomain,
        orderId: data.orderId,
        shopDomain: data.shopDomain,
        keys: Object.keys(data || {}),
        fullBody: data
      }
    });
    
  } catch (error) {
    console.error('❌ Debug endpoint error:', error);
    res.status(500).json({
      error: 'Debug failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /webhooks/debug-n8n-data
 * Simple debug endpoint to see exactly what n8n is sending
 */
router.post('/debug-n8n-data', async (req: Request, res: Response) => {
  try {
    console.log('🔍 DEBUG: Raw request body:', req.body);
    console.log('🔍 DEBUG: Request headers:', req.headers);
    console.log('🔍 DEBUG: Body type:', typeof req.body);
    
    // Handle both Buffer and parsed JSON
    let parsedBody;
    if (Buffer.isBuffer(req.body)) {
      const jsonString = req.body.toString('utf8');
      console.log('🔍 DEBUG: JSON string from buffer:', jsonString);
      try {
        parsedBody = JSON.parse(jsonString);
        console.log('🔍 DEBUG: Parsed JSON:', JSON.stringify(parsedBody, null, 2));
      } catch (parseError) {
        console.error('🔍 DEBUG: Failed to parse JSON:', parseError);
        parsedBody = { error: 'Failed to parse JSON', rawString: jsonString };
      }
    } else {
      parsedBody = req.body;
    }
    
    console.log('🔍 DEBUG: Final parsed body:', JSON.stringify(parsedBody, null, 2));
    
    res.json({
      success: true,
      message: 'Debug data received',
      data: {
        receivedBody: parsedBody,
        bodyType: typeof req.body,
        isBuffer: Buffer.isBuffer(req.body),
        headers: req.headers,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Debug endpoint error:', error);
    res.status(500).json({
      error: 'Debug endpoint error',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * GET /webhooks/debug-notion-schema
 * Debug endpoint to see the actual Notion database schema
 */
router.get('/debug-notion-schema', async (req: Request, res: Response) => {
  try {
    if (!notionService) {
      return res.status(500).json({
        error: 'Notion service not initialized'
      });
    }

    // Get the database schema
    const schema = await notionService.getDatabaseSchema();
    
    res.json({
      success: true,
      message: 'Database schema retrieved',
      data: schema
    });
  } catch (error) {
    console.error('❌ Debug schema endpoint error:', error);
    res.status(500).json({
      error: 'Debug schema endpoint error',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * POST /webhooks/test-order
 * Test endpoint to create a sample order in the user's new database
 */
router.post('/test-order', async (req: Request, res: Response) => {
  try {
    console.log('🧪 Creating test order...');
    
    const { shop } = req.body;
    const shopName = shop ? shop.replace('.myshopify.com', '') : 'testcrump1';
    
    console.log(`🏪 Creating test order for shop: ${shopName}`);

    // Find all users who have this store connected
    const usersWithStore = await userStoreService.getAllUsersWithStore(shopName);
    
    if (usersWithStore.length === 0) {
      return res.status(404).json({
        error: 'No users found with this store connected',
        shop: shopName
      });
    }

    // Create a test order
    const testOrder = {
      id: Math.floor(Math.random() * 1000000),
      order_number: Math.floor(Math.random() * 10000),
      name: `#TEST${Math.floor(Math.random() * 1000)}`,
      email: 'test@example.com',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      cancelled_at: null,
      closed_at: null,
      processed_at: new Date().toISOString(),
      customer: {
        first_name: 'Test',
        last_name: 'Customer',
        email: 'test@example.com'
      },
      billing_address: null,
      shipping_address: {
        address1: '123 Test Street',
        city: 'Test City',
        province: 'Test Province',
        country: 'Test Country',
        zip: '12345'
      },
      currency: 'USD',
      total_price: '99.99',
      subtotal_price: '89.99',
      total_tax: '10.00',
      line_items: [{
        title: 'Test Product',
        quantity: 1,
        price: '89.99'
      }],
      fulfillment_status: 'fulfilled',
      financial_status: 'paid',
      tags: 'test-order',
      note: 'This is a test order created to verify the new database connection',
      gateway: 'shopify',
      test: true,
      order_status_url: `https://${shopName}.myshopify.com/admin/orders/${Math.floor(Math.random() * 1000000)}`
    };

    // Sync to all users' Notion databases
    const syncResults = [];
    for (const { user, store } of usersWithStore) {
      try {
        console.log(`📊 Syncing test order to user ${user.email} (${user.id})`);
        console.log(`📊 User's Notion DB: ${user.notionDbId}`);
        
        // Create Notion service for this user
        const userNotionService = new NotionService(user.notionToken, user.notionDbId);
        
        // Create the page in user's Notion database
        const notionPageId = await userNotionService.createOrderPage(testOrder as any);
        
        syncResults.push({
          userId: user.id,
          userEmail: user.email,
          notionDbId: user.notionDbId,
          notionPageId: notionPageId,
          success: true
        });
        
        console.log(`✅ Test order synced to ${user.email}'s Notion database: ${notionPageId}`);
        
      } catch (userError) {
        console.error(`❌ Failed to sync test order to user ${user.email}:`, userError);
        syncResults.push({
          userId: user.id,
          userEmail: user.email,
          notionDbId: user.notionDbId,
          success: false,
          error: userError instanceof Error ? userError.message : String(userError)
        });
      }
    }

    const successfulSyncs = syncResults.filter(r => r.success).length;
    console.log(`🎉 Successfully synced test order to ${successfulSyncs}/${syncResults.length} users`);

    res.status(200).json({
      success: successfulSyncs > 0,
      message: `Test order created and synced to ${successfulSyncs}/${syncResults.length} users`,
      testOrder: {
        id: testOrder.id,
        name: testOrder.name,
        total_price: testOrder.total_price
      },
      syncResults: syncResults
    });

  } catch (error) {
    console.error('❌ Error creating test order:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create test order',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * POST /webhooks/test-user-db
 * Test endpoint to create an order in a specific user's database
 */
router.post('/test-user-db', async (req: Request, res: Response) => {
  try {
    const { userId, notionDbId } = req.body;
    
    if (!userId || !notionDbId) {
      return res.status(400).json({
        error: 'Missing required fields: userId and notionDbId'
      });
    }

    console.log(`🧪 Testing database access for user ${userId} with database ${notionDbId}`);

    // Get user info
    const user = await userStoreService.getUser(userId);
    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        userId
      });
    }

    // Create a test order
    const testOrder = {
      id: Math.floor(Math.random() * 1000000),
      order_number: Math.floor(Math.random() * 10000),
      name: `#DBTEST${Math.floor(Math.random() * 1000)}`,
      email: 'dbtest@example.com',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      cancelled_at: null,
      closed_at: null,
      processed_at: new Date().toISOString(),
      customer: {
        first_name: 'Database',
        last_name: 'Test',
        email: 'dbtest@example.com'
      },
      billing_address: null,
      shipping_address: {
        address1: '123 Database Test Street',
        city: 'Test City',
        province: 'Test Province',
        country: 'Test Country',
        zip: '12345'
      },
      currency: 'USD',
      total_price: '99.99',
      subtotal_price: '89.99',
      total_tax: '10.00',
      line_items: [{
        title: 'Database Test Product',
        quantity: 1,
        price: '89.99'
      }],
      fulfillment_status: 'fulfilled',
      financial_status: 'paid',
      tags: 'database-test',
      note: 'This is a database connectivity test order',
      gateway: 'shopify',
      test: true,
      order_status_url: `https://test.myshopify.com/admin/orders/${Math.floor(Math.random() * 1000000)}`
    };

    try {
      console.log(`📊 Testing database access for user ${user.email}`);
      console.log(`📊 Database ID: ${notionDbId}`);
      console.log(`📊 User's stored DB ID: ${user.notionDbId}`);
      
      // Create Notion service for this specific database
      const userNotionService = new NotionService(user.notionToken, notionDbId);
      
      // Test database access first
      const canAccess = await userNotionService.testConnection();
      if (!canAccess) {
        return res.status(400).json({
          error: 'Cannot access database',
          message: 'Database is not shared with the integration or does not exist',
          userId: user.id,
          userEmail: user.email,
          notionDbId: notionDbId
        });
      }
      
      // Create the page in the specified database
      const notionPageId = await userNotionService.createOrderPage(testOrder as any);
      
      console.log(`✅ Database test successful! Created page: ${notionPageId}`);
      
      res.json({
        success: true,
        message: 'Database test successful - order created',
        testOrder: {
          id: testOrder.id,
          name: testOrder.name,
          total_price: testOrder.total_price
        },
        result: {
          userId: user.id,
          userEmail: user.email,
          notionDbId: notionDbId,
          notionPageId: notionPageId,
          canAccess: true
        }
      });
      
    } catch (dbError) {
      console.error(`❌ Database test failed:`, dbError);
      res.status(500).json({
        error: 'Database access failed',
        message: dbError instanceof Error ? dbError.message : String(dbError),
        userId: user.id,
        userEmail: user.email,
        notionDbId: notionDbId
      });
    }

  } catch (error) {
    console.error('❌ Error in database test:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to test database',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router; 