import express from 'express';
import { Client } from '@notionhq/client';
import { userStoreService } from '../services/userStore';

const router = express.Router();

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_TEMPLATE_DB_ID = process.env.NOTION_TEMPLATE_DB_ID;

if (!NOTION_TOKEN) {
  console.error('❌ NOTION_TOKEN environment variable is required');
}

if (!NOTION_TEMPLATE_DB_ID) {
  console.error('❌ NOTION_TEMPLATE_DB_ID environment variable is required');
}

const notion = new Client({
  auth: NOTION_TOKEN,
});

/**
 * Duplicate a Notion database from template
 */
async function duplicateDatabase(templateDbId: string, userShopName: string): Promise<string> {
  try {
    // First, get the template database structure
    const templateDb = await notion.databases.retrieve({
      database_id: templateDbId,
    });

    // Create a new database with the same structure
    const newDb = await notion.databases.create({
      parent: {
        type: 'page_id',
        page_id: process.env.NOTION_PARENT_PAGE_ID || templateDbId, // Fallback to template if no parent specified
      },
      title: [
        {
          text: {
            content: `Shopify Orders: ${userShopName}`,
          },
        },
      ],
      properties: templateDb.properties as any, // Type assertion to handle complex Notion property types
    });

    console.log(`✅ Created new database for ${userShopName}: ${newDb.id}`);
    return newDb.id;
  } catch (error) {
    console.error('❌ Error duplicating database:', error);
    throw new Error(`Failed to duplicate database: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Share database with the integration (if needed)
 */
async function shareDatabase(databaseId: string): Promise<void> {
  try {
    // Note: Sharing permissions are typically handled at the integration level
    // This function is here for future extensibility if needed
    console.log(`📤 Database ${databaseId} is accessible via integration token`);
  } catch (error) {
    console.error('❌ Error sharing database:', error);
    throw new Error(`Failed to share database: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Test if a database is accessible
 */
async function testDatabaseAccess(databaseId: string): Promise<boolean> {
  try {
    await notion.databases.retrieve({
      database_id: databaseId,
    });
    return true;
  } catch (error) {
    console.error(`❌ Cannot access database ${databaseId}:`, error);
    return false;
  }
}

/**
 * Create a new Notion database for a user from template
 * POST /notion/create-db
 * Body: { shopDomain: string, email?: string }
 */
router.post('/create-db', async (req, res) => {
  try {
    const { shopDomain, email } = req.body;

    if (!shopDomain) {
      return res.status(400).json({ 
        error: 'Missing required field: shopDomain' 
      });
    }

    if (!NOTION_TOKEN || !NOTION_TEMPLATE_DB_ID) {
      return res.status(500).json({ 
        error: 'Server configuration error: Missing Notion credentials' 
      });
    }

    // Extract shop name from domain
    const shopName = shopDomain.replace('.myshopify.com', '');

    console.log(`🏗️ Creating Notion database for shop: ${shopName}`);

    // Test template database access first
    const canAccessTemplate = await testDatabaseAccess(NOTION_TEMPLATE_DB_ID);
    if (!canAccessTemplate) {
      return res.status(500).json({ 
        error: 'Cannot access template database. Please check configuration.' 
      });
    }

    // Duplicate the template database
    const newDbId = await duplicateDatabase(NOTION_TEMPLATE_DB_ID, shopName);

    // Share the database (if needed)
    await shareDatabase(newDbId);

    // Test access to the new database
    const canAccessNew = await testDatabaseAccess(newDbId);
    if (!canAccessNew) {
      return res.status(500).json({ 
        error: 'Created database but cannot access it. Please check permissions.' 
      });
    }

    // If we have user info, update their record
    if (email) {
      const user = userStoreService.getUserByEmail(email);
      if (user) {
        userStoreService.updateUserNotionDb(user.id, newDbId);
        console.log(`📊 Updated user ${email} with new database ID: ${newDbId}`);
      }
    }

    res.json({ 
      success: true, 
      dbId: newDbId,
      message: `Successfully created Notion database for ${shopName}`,
      shopName,
      shopDomain
    });

  } catch (error) {
    console.error('❌ Error in /create-db:', error);
    res.status(500).json({ 
      error: 'Failed to create Notion database',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Test template database access
 * GET /notion/test-template
 */
router.get('/test-template', async (req, res) => {
  try {
    if (!NOTION_TOKEN || !NOTION_TEMPLATE_DB_ID) {
      return res.status(500).json({ 
        error: 'Server configuration error: Missing Notion credentials' 
      });
    }

    const canAccess = await testDatabaseAccess(NOTION_TEMPLATE_DB_ID);
    
    if (canAccess) {
      const templateDb = await notion.databases.retrieve({
        database_id: NOTION_TEMPLATE_DB_ID,
      });

      // Extract database title safely
      let dbTitle = 'Template Database';
      if (templateDb && 'title' in templateDb && Array.isArray(templateDb.title) && templateDb.title.length > 0) {
        dbTitle = templateDb.title[0].plain_text || 'Template Database';
      }

      res.json({
        success: true,
        message: 'Template database is accessible',
        templateId: NOTION_TEMPLATE_DB_ID,
        templateTitle: dbTitle,
        propertyCount: Object.keys(templateDb.properties).length
      });
    } else {
      res.status(500).json({
        error: 'Cannot access template database',
        templateId: NOTION_TEMPLATE_DB_ID
      });
    }
  } catch (error) {
    console.error('❌ Error testing template:', error);
    res.status(500).json({ 
      error: 'Failed to test template database',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get database info
 * GET /notion/db-info/:dbId
 */
router.get('/db-info/:dbId', async (req, res) => {
  try {
    const { dbId } = req.params;

    if (!NOTION_TOKEN) {
      return res.status(500).json({ 
        error: 'Server configuration error: Missing Notion token' 
      });
    }

    const canAccess = await testDatabaseAccess(dbId);
    
    if (canAccess) {
      const database = await notion.databases.retrieve({
        database_id: dbId,
      });

      // Extract database title safely
      let dbTitle = 'Database';
      if (database && 'title' in database && Array.isArray(database.title) && database.title.length > 0) {
        dbTitle = database.title[0].plain_text || 'Database';
      }

      res.json({
        success: true,
        dbId,
        title: dbTitle,
        propertyCount: Object.keys(database.properties).length,
        createdTime: (database as any).created_time,
        lastEditedTime: (database as any).last_edited_time
      });
    } else {
      res.status(404).json({
        error: 'Database not found or not accessible',
        dbId
      });
    }
  } catch (error) {
    console.error('❌ Error getting database info:', error);
    res.status(500).json({ 
      error: 'Failed to get database info',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router; 