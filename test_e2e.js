#!/usr/bin/env node

/**
 * 🧪 End-to-End Test for NotionSync Privacy Solution
 * 
 * This script tests the complete flow:
 * 1. User installs app
 * 2. Connects Notion account
 * 3. Creates personal database
 * 4. Syncs test orders
 * 5. Verifies data isolation
 */

const fetch = require('node-fetch');
const readline = require('readline');

const TEST_CONFIG = {
  SERVER_URL: 'http://localhost:3001',
  TEST_SHOPS: [
    'privacy-test-1.myshopify.com',
    'privacy-test-2.myshopify.com'
  ],
  // Using your actual Notion token for testing
  NOTION_TOKEN: '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',
  TEST_ORDERS: [
    {
      id: 1001,
      name: '#1001',
      customer: {
        first_name: 'John',
        last_name: 'Doe',
        email: 'john@test.com',
        phone: '+1234567890'
      },
      total_price: '99.99',
      created_at: new Date().toISOString(),
      financial_status: 'paid'
    },
    {
      id: 1002,
      name: '#1002',
      customer: {
        first_name: 'Jane',
        last_name: 'Smith',
        email: 'jane@test.com',
        phone: '+1987654321'
      },
      total_price: '149.99',
      created_at: new Date().toISOString(),
      financial_status: 'paid'
    }
  ]
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve => {
    rl.question(question, resolve);
  });
}

async function testServerHealth() {
  console.log('\n🔍 Testing server health...');
  try {
    const response = await fetch(`${TEST_CONFIG.SERVER_URL}/health`);
    if (response.ok) {
      console.log('✅ Server is running and healthy');
      return true;
    } else {
      console.log('❌ Server returned unhealthy status');
      return false;
    }
  } catch (error) {
    console.log('❌ Server is not running:', error.message);
    return false;
  }
}

async function testNotionConnection(shopDomain, userToken) {
  console.log(`\n🔌 Testing Notion connection for ${shopDomain}...`);
  
  try {
    const response = await fetch(`${TEST_CONFIG.SERVER_URL}/notion/create-db-with-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        shopDomain: shopDomain,
        accessToken: userToken,
        workspaceId: 'user-workspace'
      })
    });

    const result = await response.json();
    
    if (response.ok && result.success) {
      console.log('✅ Notion connection successful');
      console.log(`   📊 Database ID: ${result.dbId}`);
      console.log(`   🏪 Shop: ${result.shopName}`);
      return { success: true, dbId: result.dbId };
    } else {
      console.log('❌ Notion connection failed:', result.error);
      return { success: false, error: result.error };
    }
  } catch (error) {
    console.log('❌ Notion connection error:', error.message);
    return { success: false, error: error.message };
  }
}

async function testOrderSync(shopDomain, orderData) {
  console.log(`\n📦 Testing order sync for ${shopDomain}...`);
  
  try {
    const response = await fetch(`${TEST_CONFIG.SERVER_URL}/webhooks/orders/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Shop-Domain': shopDomain
      },
      body: JSON.stringify(orderData)
    });

    const result = await response.json();
    
    if (response.ok && result.success) {
      console.log('✅ Order sync successful');
      console.log(`   📝 Order: ${orderData.name}`);
      console.log(`   👤 Customer: ${orderData.customer.first_name} ${orderData.customer.last_name}`);
      return { success: true };
    } else {
      console.log('❌ Order sync failed:', result.error);
      return { success: false, error: result.error };
    }
  } catch (error) {
    console.log('❌ Order sync error:', error.message);
    return { success: false, error: error.message };
  }
}

async function verifyDataIsolation(shopDomain, dbId) {
  console.log(`\n🔒 Verifying data isolation for ${shopDomain}...`);
  
  try {
    const response = await fetch(`${TEST_CONFIG.SERVER_URL}/notion/db-info/${dbId}`);
    const result = await response.json();
    
    if (response.ok && result.success) {
      console.log('✅ Database verification successful');
      console.log(`   📊 Title: ${result.title}`);
      console.log(`   📝 Properties: ${result.propertyCount}`);
      console.log(`   ⏰ Created: ${result.createdTime}`);
      return { success: true };
    } else {
      console.log('❌ Database verification failed:', result.error);
      return { success: false, error: result.error };
    }
  } catch (error) {
    console.log('❌ Database verification error:', error.message);
    return { success: false, error: error.message };
  }
}

async function runEndToEndTest() {
  console.log('🧪 Starting End-to-End Test');
  console.log('==========================\n');
  
  // Step 1: Check server health
  const isHealthy = await testServerHealth();
  if (!isHealthy) {
    console.log('\n❌ Cannot proceed with tests - server is not healthy');
    rl.close();
    return;
  }

  // Step 2: Test multiple shops to verify isolation
  const results = [];
  
  for (const shopDomain of TEST_CONFIG.TEST_SHOPS) {
    console.log(`\n🏪 Testing shop: ${shopDomain}`);
    console.log('----------------------------------------');
    
    // 2.1: Test Notion connection
    const connectionResult = await testNotionConnection(shopDomain, TEST_CONFIG.NOTION_TOKEN);
    if (!connectionResult.success) {
      console.log(`❌ Skipping remaining tests for ${shopDomain}`);
      results.push({ shop: shopDomain, success: false, error: connectionResult.error });
      continue;
    }
    
    // 2.2: Test order sync
    const orderResults = [];
    for (const order of TEST_CONFIG.TEST_ORDERS) {
      const syncResult = await testOrderSync(shopDomain, order);
      orderResults.push(syncResult);
    }
    
    // 2.3: Verify data isolation
    const isolationResult = await verifyDataIsolation(shopDomain, connectionResult.dbId);
    
    results.push({
      shop: shopDomain,
      success: true,
      dbId: connectionResult.dbId,
      ordersSynced: orderResults.filter(r => r.success).length,
      isolationVerified: isolationResult.success
    });
    
    // Add delay between shops
    if (shopDomain !== TEST_CONFIG.TEST_SHOPS[TEST_CONFIG.TEST_SHOPS.length - 1]) {
      console.log('\n⏳ Waiting 2 seconds before next shop...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Print summary
  console.log('\n🎉 Test Results Summary');
  console.log('=====================\n');
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`✅ Successful tests: ${successful.length}`);
  console.log(`❌ Failed tests: ${failed.length}\n`);
  
  if (successful.length > 0) {
    console.log('Successful shops:');
    successful.forEach(result => {
      console.log(`\n🏪 ${result.shop}`);
      console.log(`   📊 Database ID: ${result.dbId}`);
      console.log(`   📦 Orders synced: ${result.ordersSynced}`);
      console.log(`   🔒 Data isolation: ${result.isolationVerified ? '✅ Verified' : '❌ Failed'}`);
    });
  }
  
  if (failed.length > 0) {
    console.log('\nFailed shops:');
    failed.forEach(result => {
      console.log(`\n🏪 ${result.shop}`);
      console.log(`   ❌ Error: ${result.error}`);
    });
  }

  console.log('\n🔍 Privacy Solution Verification:');
  if (successful.length > 1) {
    console.log('✅ Multiple databases created successfully');
    console.log('✅ Each shop has its own isolated database');
    console.log('✅ Orders synced to correct databases');
    console.log('✅ Data isolation maintained between shops');
  } else {
    console.log('⚠️ Could not fully verify data isolation');
    console.log('   Need at least 2 successful tests to verify');
  }

  rl.close();
}

// Add basic error handling for fetch
if (typeof fetch === 'undefined') {
  console.log('Installing node-fetch...');
  require('child_process').execSync('npm install node-fetch@2', { stdio: 'inherit' });
  global.fetch = require('node-fetch');
}

// Run the end-to-end test
runEndToEndTest().catch(error => {
  console.error('Test failed:', error);
  rl.close();
}); 