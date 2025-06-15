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
    
    // Debug key fields that are having issues
    console.log(`🔍 Notion service debugging:`);
    console.log(`  - order.name: ${order.name}`);
    console.log(`  - order.order_number: ${order.order_number}`);
    console.log(`  - order.created_at: ${order.created_at}`);
    console.log(`  - order.note: ${order.note}`);
    console.log(`  - order.shipping_address: ${JSON.stringify(order.shipping_address)}`);
      console.log('📋 Order data received:', JSON.stringify(order, null, 2));

      // Format line items as a readable string
      const lineItemsText = order.line_items
        .map(item => `${item.title} (x${item.quantity}) - $${item.price}`)
        .join('\n');

      // First, get the database schema to see what properties exist
      const database = await this.notion.databases.retrieve({
        database_id: this.databaseId,
      });

      console.log('📊 Database properties:', Object.keys(database.properties as any));

      const properties: any = {};
      
      // Find the title property (there should be exactly one)
      const titleProperty = Object.entries(database.properties as any).find(
        ([key, prop]: [string, any]) => prop.type === 'title'
      );
      
      if (titleProperty) {
        const titleValue = order.name || `Order #${order.order_number}`;
        properties[titleProperty[0]] = {
          title: [
            {
              text: {
                content: titleValue,
              },
            },
          ],
        };
        console.log(`📝 Setting title "${titleProperty[0]}" to: ${titleValue}`);
      }

      // Add other properties if they exist in the database
      Object.entries(database.properties as any).forEach(([propName, propConfig]: [string, any]) => {
        if (propConfig.type === 'title') return; // Already handled above
        
        const propNameLower = propName.toLowerCase();
        console.log(`🔍 Checking property: ${propName} (type: ${propConfig.type})`);
        
        // Try to match common property names and types
        switch (propConfig.type) {
          case 'rich_text':
            if ((propNameLower.includes('customer') || propNameLower.includes('name')) && order.customer) {
              const customerName = `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim();
              if (customerName) {
                properties[propName] = {
                  rich_text: [
                    {
                      text: {
                        content: customerName,
                      },
                    },
                  ],
                };
                console.log(`📝 Setting customer name "${propName}" to: ${customerName}`);
              }
            } else if (propNameLower.includes('email') && order.customer?.email) {
              properties[propName] = {
                rich_text: [
                  {
                    text: {
                      content: order.customer.email,
                    },
                  },
                ],
              };
              console.log(`📝 Setting email "${propName}" to: ${order.customer.email}`);
            } else if ((propNameLower.includes('line') || propNameLower.includes('item') || propNameLower.includes('product')) && lineItemsText) {
              properties[propName] = {
                rich_text: [
                  {
                    text: {
                      content: lineItemsText,
                    },
                  },
                ],
              };
              console.log(`📝 Setting items "${propName}" to: ${lineItemsText}`);
            } else if ((propNameLower.includes('address') || propNameLower.includes('shipping')) && order.shipping_address) {
              const address = order.shipping_address;
              const addressText = [
                address.first_name,
                address.last_name,
                address.address1,
                address.address2,
                address.city,
                address.province,
                address.zip,
                address.country
              ].filter(Boolean).join(', ');
              
              properties[propName] = {
                rich_text: [
                  {
                    text: {
                      content: addressText || 'No Address',
                    },
                  },
                ],
              };
              console.log(`📝 Setting address "${propName}" to: ${addressText}`);
            } else if (propNameLower.includes('note') && order.note) {
              properties[propName] = {
                rich_text: [
                  {
                    text: {
                      content: order.note,
                    },
                  },
                ],
              };
              console.log(`📝 Setting notes "${propName}" to: ${order.note}`);
            }
            break;
          
          case 'number':
            if ((propNameLower.includes('total') || propNameLower.includes('price')) && order.total_price) {
              const totalPrice = parseFloat(order.total_price);
              if (!isNaN(totalPrice)) {
                properties[propName] = {
                  number: totalPrice,
                };
                console.log(`📝 Setting total price "${propName}" to: ${totalPrice}`);
              }
            } else if ((propNameLower.includes('order') && propNameLower.includes('id')) && order.id) {
              properties[propName] = {
                number: parseInt(order.id.toString()) || 0,
              };
              console.log(`📝 Setting order ID "${propName}" to: ${order.id}`);
            } else if ((propNameLower.includes('order') && propNameLower.includes('number')) && order.order_number) {
              properties[propName] = {
                number: order.order_number || 0,
              };
              console.log(`📝 Setting order number "${propName}" to: ${order.order_number}`);
            }
            break;
          
          case 'date':
            if ((propNameLower.includes('created') || propNameLower.includes('date') || propNameLower.includes('order')) && order.created_at) {
              properties[propName] = {
                date: {
                  start: order.created_at,
                },
              };
              console.log(`📝 Setting date "${propName}" to: ${order.created_at}`);
            }
            break;
          
          case 'select':
            if (propNameLower.includes('currency') && order.currency) {
              properties[propName] = {
                select: {
                  name: order.currency || 'USD',
                },
              };
              console.log(`📝 Setting currency "${propName}" to: ${order.currency}`);
            } else if (propNameLower.includes('status')) {
              // Check for fulfillment status first, then financial status
              let statusValue = 'pending';
              if (order.fulfillment_status) {
                statusValue = order.fulfillment_status;
              } else if (order.financial_status) {
                statusValue = order.financial_status;
              }
              
              properties[propName] = {
                select: {
                  name: statusValue,
                },
              };
              console.log(`📝 Setting status "${propName}" to: ${statusValue} (fulfillment: ${order.fulfillment_status}, financial: ${order.financial_status})`);
            }
            break;
            
          case 'status':
            if (propNameLower.includes('status')) {
              // Handle Notion's status field type (different from select)
              // Map from your n8n workflow's capitalized values to Notion status values
              let statusValue = 'Unfulfilled'; // Default to Unfulfilled (capitalized for Notion)
              
              if (order.fulfillment_status) {
                const fulfillmentStatus = order.fulfillment_status.toLowerCase();
                // Map common fulfillment statuses to proper Notion status values
                switch (fulfillmentStatus) {
                  case 'fulfilled':
                    statusValue = 'Fulfilled';
                    break;
                  case 'partially_fulfilled':
                  case 'partially fulfilled':
                    statusValue = 'Partially Fulfilled';
                    break;
                  case 'in_progress':
                  case 'in progress':
                    statusValue = 'In Progress';
                    break;
                  case 'on_hold':
                  case 'on hold':
                    statusValue = 'On Hold';
                    break;
                  case 'scheduled':
                    statusValue = 'Scheduled';
                    break;
                  case 'restocked':
                    statusValue = 'Restocked';
                    break;
                  case 'unfulfilled':
                  case 'open':
                  default:
                    statusValue = 'Unfulfilled';
                    break;
                }
              } else if (order.financial_status) {
                // Fallback to financial status if no fulfillment status
                const financialStatus = order.financial_status.toLowerCase();
                switch (financialStatus) {
                  case 'paid':
                    statusValue = 'Fulfilled';
                    break;
                  case 'pending':
                  case 'authorized':
                  default:
                    statusValue = 'Unfulfilled';
                    break;
                }
              }
              
              properties[propName] = {
                status: {
                  name: statusValue,
                },
              };
              console.log(`📝 Setting status field "${propName}" to: ${statusValue} (fulfillment: ${order.fulfillment_status}, financial: ${order.financial_status})`);
            }
            break;
            
          case 'email':
            if (propNameLower.includes('email') && order.customer?.email) {
              properties[propName] = {
                email: order.customer.email,
              };
              console.log(`📝 Setting email field "${propName}" to: ${order.customer.email}`);
            }
            break;
            
          case 'url':
            if ((propNameLower.includes('shopify') || propNameLower.includes('link')) && order.order_status_url) {
              properties[propName] = {
                url: order.order_status_url,
              };
              console.log(`📝 Setting URL "${propName}" to: ${order.order_status_url}`);
            }
            break;
            
          case 'checkbox':
            if (propNameLower.includes('value') || propNameLower.includes('high')) {
              const totalPrice = parseFloat(order.total_price || '0');
              const isHighValue = totalPrice > 100; // You can adjust this threshold
              properties[propName] = {
                checkbox: isHighValue,
              };
              console.log(`📝 Setting checkbox "${propName}" to: ${isHighValue} (price: ${totalPrice})`);
            }
            break;
        }
      });

      console.log(`📊 Final properties to be set:`, Object.keys(properties));

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