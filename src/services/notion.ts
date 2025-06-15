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

      // Create the page in Notion
      const response = await this.notion.pages.create({
        parent: {
          database_id: this.databaseId,
        },
        properties: {
          // Order Title - using order name as the title
          'Name': {
            title: [
              {
                text: {
                  content: order.name || `Order #${order.order_number}`,
                },
              },
            ],
          },
          
          // Order Number
          'Order Number': {
            number: order.order_number,
          },
          
          // Order ID
          'Order ID': {
            rich_text: [
              {
                text: {
                  content: order.id.toString(),
                },
              },
            ],
          },
          
          // Customer Name
          'Customer': {
            rich_text: [
              {
                text: {
                  content: `${order.customer.first_name} ${order.customer.last_name}`,
                },
              },
            ],
          },
          
          // Customer Email - handle different property types
          ...(order.customer.email ? {
            'Email': {
              rich_text: [
                {
                  text: {
                    content: order.customer.email,
                  },
                },
              ],
            },
          } : {}),
          
          // Total Price
          'Total': {
            number: parseFloat(order.total_price),
          },
          
          // Currency
          'Currency': {
            select: {
              name: order.currency,
            },
          },
          
          // Financial Status
          'Financial Status': {
            select: {
              name: order.financial_status,
            },
          },
          
          // Fulfillment Status
          'Fulfillment Status': {
            select: {
              name: order.fulfillment_status || 'unfulfilled',
            },
          },
          
          // Created Date
          'Created At': {
            date: {
              start: order.created_at,
            },
          },
          
          // Line Items
          'Line Items': {
            rich_text: [
              {
                text: {
                  content: lineItemsText,
                },
              },
            ],
          },
          
          // Shipping Address
          'Shipping Address': {
            rich_text: [
              {
                text: {
                  content: order.shipping_address
                    ? `${order.shipping_address.address1}${order.shipping_address.address2 ? ', ' + order.shipping_address.address2 : ''}, ${order.shipping_address.city}, ${order.shipping_address.province} ${order.shipping_address.zip}, ${order.shipping_address.country}`
                    : 'No shipping address',
                },
              },
            ],
          },
        },
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