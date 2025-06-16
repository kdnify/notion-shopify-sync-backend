import express from 'express';
import { Client } from '@notionhq/client';
import { userStoreService } from '../services/userStore';
import { Request, Response } from 'express';

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

    // Clean the properties to remove read-only fields
    const cleanProperties = JSON.parse(JSON.stringify(templateDb.properties));
    
    // Remove read-only fields that can't be set during creation
    Object.keys(cleanProperties).forEach(key => {
      const prop = cleanProperties[key];
      if (prop.type === 'status') {
        // Remove options and groups for status properties - Notion will create defaults
        delete prop.status.options;
        delete prop.status.groups;
      }
      if (prop.type === 'select' || prop.type === 'multi_select') {
        // Remove options for select properties - they'll be empty initially
        delete prop.select?.options;
        delete prop.multi_select?.options;
      }
    });

    // We need a page ID as parent, not a database ID
    // For now, we'll use the workspace as parent since we don't have a specific page
    const newDb = await notion.databases.create({
      parent: {
        type: 'workspace',
        workspace: true
      } as any,
      title: [
        {
          text: {
            content: `Shopify Orders: ${userShopName}`,
          },
        },
      ],
      properties: cleanProperties as any, // Type assertion to handle complex Notion property types
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
      const user = await userStoreService.getUserByEmail(email);
      if (user) {
        await userStoreService.updateUserNotionDb(user.id, newDbId);
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

/**
 * Create a new Notion database using user's OAuth token
 * POST /notion/create-db-with-token
 * Body: { shopDomain: string, accessToken: string, workspaceId: string }
 */
router.post('/create-db-with-token', async (req, res) => {
  try {
    const { shopDomain, accessToken, workspaceId } = req.body;

    if (!shopDomain || !accessToken) {
      return res.status(400).json({ 
        error: 'Missing required fields: shopDomain and accessToken' 
      });
    }

    // Extract shop name from domain
    const shopName = shopDomain.replace('.myshopify.com', '');

    console.log(`🏗️ Creating Notion database with user's token for shop: ${shopName}`);

    // Create Notion client with user's token
    const userNotion = new Client({
      auth: accessToken,
    });

    // First, get the template database structure
    const templateNotion = new Client({
      auth: NOTION_TOKEN,
    });

    if (!NOTION_TEMPLATE_DB_ID) {
      return res.status(500).json({ 
        error: 'Server configuration error: Missing template database ID' 
      });
    }

    const templateDb = await templateNotion.databases.retrieve({
      database_id: NOTION_TEMPLATE_DB_ID,
    });

    // Find a suitable parent page in user's workspace
    // First, try to find the user's workspace pages
    const searchResponse = await userNotion.search({
      filter: {
        value: 'page',
        property: 'object'
      },
      page_size: 10
    });

    let parentPageId = null;
    
    // Look for a suitable parent page (preferably one the user owns)
    for (const result of searchResponse.results) {
      if (result.object === 'page' && 'parent' in result) {
        // Use the first page we find as parent
        parentPageId = result.id;
        break;
      }
    }

    // If no suitable page found, create one in the workspace
    if (!parentPageId) {
      const newPage = await userNotion.pages.create({
        parent: {
          type: 'workspace',
          workspace: true
        } as any,
        properties: {
          title: {
            title: [
              {
                text: {
                  content: `NotionSync - ${shopName}`
                }
              }
            ]
          }
        }
      });
      parentPageId = newPage.id;
      console.log(`📄 Created parent page: ${parentPageId}`);
    }

    // Clean the properties to remove read-only fields
    const cleanProperties = JSON.parse(JSON.stringify(templateDb.properties));
    
    // Remove read-only fields that can't be set during creation
    Object.keys(cleanProperties).forEach(key => {
      const prop = cleanProperties[key];
      if (prop.type === 'status') {
        // Remove options and groups for status properties - Notion will create defaults
        delete prop.status.options;
        delete prop.status.groups;
      }
      if (prop.type === 'select' || prop.type === 'multi_select') {
        // Remove options for select properties - they'll be empty initially
        delete prop.select?.options;
        delete prop.multi_select?.options;
      }
    });

    // Create a new database in user's workspace
    const newDb = await userNotion.databases.create({
      parent: {
        type: 'page_id',
        page_id: parentPageId,
      } as any,
      title: [
        {
          text: {
            content: `Shopify Orders: ${shopName}`,
          },
        },
      ],
      properties: cleanProperties as any,
    });

    console.log(`✅ Created new database for ${shopName}: ${newDb.id}`);

    res.json({ 
      success: true, 
      dbId: newDb.id,
      message: `Successfully created Notion database for ${shopName}`,
      shopName,
      shopDomain
    });

  } catch (error) {
    console.error('❌ Error in /create-db-with-token:', error);
    res.status(500).json({ 
      error: 'Failed to create Notion database with user token',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Create a template database for a user (simplified approach)
 * POST /notion/create-template-db
 * Body: { shopDomain: string }
 */
router.post('/create-template-db', async (req, res) => {
  try {
    const { shopDomain } = req.body;

    if (!shopDomain) {
      return res.status(400).json({ 
        error: 'Missing required field: shopDomain' 
      });
    }

    if (!NOTION_TOKEN) {
      return res.status(500).json({ 
        error: 'Server configuration error: Missing Notion token' 
      });
    }

    // Extract shop name from domain
    const shopName = shopDomain.replace('.myshopify.com', '');

    console.log(`🏗️ Creating template database for shop: ${shopName}`);

    // First create a page to hold the database (since we can't create directly in workspace)
    const parentPage = await notion.pages.create({
      parent: {
        type: 'workspace',
        workspace: true
      } as any,
      properties: {
        title: {
          title: [
            {
              text: {
                content: `NotionSync - ${shopName}`
              }
            }
          ]
        }
      }
    });

    console.log(`📄 Created parent page: ${parentPage.id}`);

    // Create a new database with order tracking properties
    const newDb = await notion.databases.create({
      parent: {
        type: 'page_id',
        page_id: parentPage.id
      } as any,
      title: [
        {
          text: {
            content: `Shopify Orders: ${shopName}`,
          },
        },
      ],
      properties: {
        'Order Number': {
          type: 'title',
          title: {}
        },
        'Customer Name': {
          type: 'rich_text',
          rich_text: {}
        },
        'Customer Email': {
          type: 'email',
          email: {}
        },
        'Total Price': {
          type: 'number',
          number: {
            format: 'dollar'
          }
        },
        'Order Status': {
          type: 'select',
          select: {
            options: [
              { name: 'Pending', color: 'yellow' },
              { name: 'Paid', color: 'green' },
              { name: 'Fulfilled', color: 'blue' },
              { name: 'Cancelled', color: 'red' }
            ]
          }
        },
        'Shipping Address': {
          type: 'rich_text',
          rich_text: {}
        },
        'Items': {
          type: 'rich_text',
          rich_text: {}
        },
        'Shopify Link': {
          type: 'url',
          url: {}
        },
        'Created Date': {
          type: 'date',
          date: {}
        },
        'Notes': {
          type: 'rich_text',
          rich_text: {}
        }
      } as any
    });

    console.log(`✅ Created template database: ${newDb.id}`);

    // Update user with the new database ID
    const shopNameClean = shopName.toLowerCase();
    const usersWithStore = await userStoreService.getAllUsersWithStore(shopNameClean);
    
    if (usersWithStore.length > 0) {
      const { user } = usersWithStore[0];
      await userStoreService.updateUserNotionDb(user.id, newDb.id);
      console.log(`📊 Updated user ${user.id} with template database: ${newDb.id}`);
    } else {
      console.warn(`⚠️ No user found for shop: ${shopNameClean}, database created but not linked`);
    }

    res.json({ 
      success: true, 
      dbId: newDb.id,
      message: `Successfully created template database for ${shopName}`,
      shopName,
      shopDomain,
      dbUrl: `https://www.notion.so/${newDb.id.replace(/-/g, '')}`
    });

  } catch (error) {
    console.error('❌ Error in /create-template-db:', error);
    res.status(500).json({ 
      error: 'Failed to create template database',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /notion/test-db-access
 * Test if system token can access a specific database
 */
router.post('/test-db-access', async (req: Request, res: Response) => {
  try {
    const { dbId } = req.body;
    
    if (!dbId) {
      return res.status(400).json({
        error: 'Missing database ID',
        message: 'Please provide dbId in request body'
      });
    }
    
    if (!NOTION_TOKEN) {
      return res.status(500).json({
        error: 'System token not configured',
        message: 'NOTION_TOKEN environment variable is required'
      });
    }
    
    console.log(`🧪 Testing access to database: ${dbId}`);
    
    // Try to query the database
    const response = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        page_size: 1
      })
    });
    
    if (response.ok) {
      const data = await response.json() as any;
      console.log(`✅ Successfully accessed database ${dbId}`);
      
      res.json({
        success: true,
        message: 'Database access successful',
        data: {
          dbId: dbId,
          resultCount: data.results?.length || 0,
          hasAccess: true
        }
      });
    } else {
      const errorData = await response.json() as any;
      console.log(`❌ Failed to access database ${dbId}:`, errorData);
      
      res.json({
        success: false,
        message: 'Database access failed',
        error: errorData.message || 'Unknown error',
        data: {
          dbId: dbId,
          hasAccess: false,
          statusCode: response.status
        }
      });
    }
    
  } catch (error) {
    console.error('❌ Error testing database access:', error);
    res.status(500).json({
      error: 'Test failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router; 