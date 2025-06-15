#!/usr/bin/env node

/**
 * Simple test script to verify the /notion/create-db-with-token endpoint
 * This tests the core privacy-preserving functionality
 */

const fetch = require('node-fetch'); // You may need: npm install node-fetch

const TEST_CONFIG = {
  // Update these for your test environment
  SERVER_URL: 'http://localhost:3001',
  TEST_SHOP_DOMAIN: 'test-store.myshopify.com',
  TEST_ACCESS_TOKEN: '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', // Use your Notion integration token for testing
  TEST_WORKSPACE_ID: 'test-workspace'
};

async function testCreateDbWithToken() {
  console.log('🧪 Testing /notion/create-db-with-token endpoint...\n');

  try {
    const response = await fetch(`${TEST_CONFIG.SERVER_URL}/notion/create-db-with-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        shopDomain: TEST_CONFIG.TEST_SHOP_DOMAIN,
        accessToken: TEST_CONFIG.TEST_ACCESS_TOKEN,
        workspaceId: TEST_CONFIG.TEST_WORKSPACE_ID
      })
    });

    const result = await response.json();

    console.log('📊 Response Status:', response.status);
    console.log('📊 Response Body:', JSON.stringify(result, null, 2));

    if (response.ok && result.success) {
      console.log('\n✅ TEST PASSED');
      console.log(`✅ Personal database created: ${result.dbId}`);
      console.log(`✅ Shop: ${result.shopName}`);
      console.log(`✅ Message: ${result.message}`);
      
      // Test database info endpoint
      await testDatabaseInfo(result.dbId);
      
    } else {
      console.log('\n❌ TEST FAILED');
      console.log('❌ Error:', result.error);
      console.log('❌ Details:', result.details);
    }

  } catch (error) {
    console.log('\n❌ TEST ERROR');
    console.log('❌ Failed to connect to server:', error.message);
    console.log('❌ Make sure the server is running on', TEST_CONFIG.SERVER_URL);
  }
}

async function testDatabaseInfo(dbId) {
  console.log('\n🔍 Testing database info endpoint...');
  
  try {
    const response = await fetch(`${TEST_CONFIG.SERVER_URL}/notion/db-info/${dbId}`);
    const result = await response.json();
    
    if (response.ok && result.success) {
      console.log('✅ Database info retrieved successfully:');
      console.log(`   Title: ${result.title}`);
      console.log(`   Properties: ${result.propertyCount}`);
      console.log(`   Created: ${result.createdTime}`);
    } else {
      console.log('⚠️ Database info test failed:', result.error);
    }
  } catch (error) {
    console.log('⚠️ Database info test error:', error.message);
  }
}

async function testTemplateAccess() {
  console.log('\n🧪 Testing template database access...');
  
  try {
    const response = await fetch(`${TEST_CONFIG.SERVER_URL}/notion/test-template`);
    const result = await response.json();
    
    console.log('📊 Template Test Status:', response.status);
    console.log('📊 Template Test Result:', JSON.stringify(result, null, 2));
    
    if (response.ok && result.success) {
      console.log('✅ Template database accessible');
      console.log(`✅ Template: ${result.title}`);
    } else {
      console.log('❌ Template database issue:', result.error);
    }
  } catch (error) {
    console.log('❌ Template test error:', error.message);
  }
}

async function runAllTests() {
  console.log('🚀 Starting NotionSync Endpoint Tests\n');
  console.log('📝 Configuration:');
  console.log(`   Server: ${TEST_CONFIG.SERVER_URL}`);
  console.log(`   Test Shop: ${TEST_CONFIG.TEST_SHOP_DOMAIN}`);
  console.log(`   Has Token: ${TEST_CONFIG.TEST_ACCESS_TOKEN ? 'Yes' : 'No'}\n`);

  // Test template access first
  await testTemplateAccess();
  
  // Test main functionality
  await testCreateDbWithToken();
  
  console.log('\n🏁 Tests completed!');
  console.log('\n💡 Next Steps:');
  console.log('   1. If tests pass: Your endpoint is working correctly ✅');
  console.log('   2. If tests fail: Check server logs and configuration ⚠️');
  console.log('   3. Ready to proceed with Phase 2: Database persistence 🎯');
}

// Run the tests
runAllTests().catch(console.error); 