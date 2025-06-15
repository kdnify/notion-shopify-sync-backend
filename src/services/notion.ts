import { Client } from '@notionhq/client';
import { ShopifyOrder } from '../utils/verifyShopify';

export class NotionService {
  private notion: Client;
  private databaseId: string;

  constructor(customToken?: string, customDatabaseId?: string) {
    const notionToken = customToken || process.env.NOTION_TOKEN;
    const databaseId = customDatabaseId || process.env.NOTION_DB_ID;

    if (!notionToken) {
      throw new Error('NOTION_TOKEN environment variable or custom token is required');
    }

    if (!databaseId) {
      throw new Error('NOTION_DB_ID environment variable or custom database ID is required');
    }

    this.notion = new Client({
      auth: notionToken,
    });

    this.databaseId = databaseId;
  }

  /**
   * Creates a new page in the Notion database for a Shopify order
   * @param order - The Shopify order data
   * @returns Promise<string> - The ID of the created page
   */
  async createOrderPage(order: ShopifyOrder): Promise<string> {
    try {
      console.log(`Creating Notion page for order #${order.order_number}`);

      // Format line items as a readable string
      const lineItemsText = order.line_items
        .map(item => `${item.title} (x${item.quantity}) - $${item.price}`)
        .join('\n');

      // First, get the database schema to see what properties exist
      const database = await this.notion.databases.retrieve({
        database_id: this.databaseId,
      });

      const properties: any = {};
      
      // Find the title property (there should be exactly one)
      const titleProperty = Object.entries(database.properties as any).find(
        ([key, prop]: [string, any]) => prop.type === 'title'
      );
      
      if (titleProperty) {
        properties[titleProperty[0]] = {
          title: [
            {
              text: {
                content: order.name || `Order #${order.order_number}`,
              },
            },
          ],
        };
      }

      // Add other properties if they exist in the database
      Object.entries(database.properties as any).forEach(([propName, propConfig]: [string, any]) => {
        if (propConfig.type === 'title') return; // Already handled above
        
        // Try to match common property names and types
        switch (propConfig.type) {
          case 'rich_text':
            if (propName.toLowerCase().includes('customer') && order.customer) {
              properties[propName] = {
                rich_text: [
                  {
                    text: {
                      content: `${order.customer.first_name} ${order.customer.last_name}`,
                    },
                  },
                ],
              };
            } else if (propName.toLowerCase().includes('email') && order.customer?.email) {
              properties[propName] = {
                rich_text: [
                  {
                    text: {
                      content: order.customer.email,
                    },
                  },
                ],
              };
            } else if (propName.toLowerCase().includes('line') || propName.toLowerCase().includes('item')) {
              properties[propName] = {
                rich_text: [
                  {
                    text: {
                      content: lineItemsText,
                    },
                  },
                ],
              };
            }
            break;
          
          case 'number':
            if (propName.toLowerCase().includes('total') || propName.toLowerCase().includes('price')) {
              properties[propName] = {
                number: parseFloat(order.total_price) || 0,
              };
            } else if (propName.toLowerCase().includes('order') && propName.toLowerCase().includes('number')) {
              properties[propName] = {
                number: order.order_number || 0,
              };
            }
            break;
          
          case 'date':
            if (propName.toLowerCase().includes('created') && order.created_at) {
              properties[propName] = {
                date: {
                  start: order.created_at,
                },
              };
            }
            break;
          
          case 'select':
            if (propName.toLowerCase().includes('currency')) {
              properties[propName] = {
                select: {
                  name: order.currency || 'USD',
                },
              };
            } else if (propName.toLowerCase().includes('status')) {
              properties[propName] = {
                select: {
                  name: order.financial_status || 'pending',
                },
              };
            }
            break;
        }
      });

      // Create the page in Notion
      const response = await this.notion.pages.create({
        parent: {
          database_id: this.databaseId,
        },
        properties,
      });

      console.log(`✅ Successfully created Notion page for order #${order.order_number}`);
      return response.id;
    } catch (error) {
      console.error('Error creating Notion page:', error);
      throw new Error(`Failed to create Notion page: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Tests the Notion connection and verifies the database exists
   * @returns Promise<boolean>
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.notion.databases.retrieve({
        database_id: this.databaseId,
      });
      
      // Extract database title safely
      let dbTitle = 'Database';
      if (response && 'title' in response && Array.isArray(response.title) && response.title.length > 0) {
        dbTitle = response.title[0].plain_text || 'Database';
      }
      
      console.log(`✅ Connected to Notion database: ${dbTitle}`);
      console.log(`📊 Database ID: ${this.databaseId}`);
      return true;
    } catch (error) {
      console.error('❌ Failed to connect to Notion:');
      console.error('Database ID:', this.databaseId);
      console.error('Error:', error);
      return false;
    }
  }
} 