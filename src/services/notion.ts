import { Client } from '@notionhq/client';
import { ShopifyOrder } from '../utils/verifyShopify';

export class NotionService {
  private notion: Client;
  private databaseId: string;

  constructor(customToken?: string, customDatabaseId?: string) {
    const notionToken = customToken || process.env.NOTION_TOKEN;
    const databaseId = customDatabaseId;

    if (!notionToken) {
      throw new Error('NOTION_TOKEN environment variable or custom token is required');
    }

    if (!databaseId) {
      throw new Error('Database ID is required - no fallback to shared database allowed');
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
        
        console.log(`🔍 Checking property: ${propName} (type: ${propConfig.type})`);
        
        // Map to exact property names in the user's database
        switch (propName) {
          case 'Customer Name':
            console.log(`🔍 Customer Name debug:`, {
              hasCustomer: !!order.customer,
              firstName: order.customer?.first_name,
              lastName: order.customer?.last_name,
              fullName: order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : 'none'
            });
            
            if (order.customer) {
              const customerName = `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim();
              // Show actual customer name even if it's a placeholder, for debugging
              if (customerName && customerName !== 'Manual Order No Customer') {
                properties[propName] = {
                  rich_text: [
                    {
                      text: {
                        content: customerName,
                      },
                    },
                  ],
                };
                console.log(`📝 Setting "${propName}" to: ${customerName}`);
              } else {
                // For manual orders, show what we have
                const displayName = customerName || 'Manual Order';
                properties[propName] = {
                  rich_text: [
                    {
                      text: {
                        content: displayName,
                      },
                    },
                  ],
                };
                console.log(`📝 Setting "${propName}" to: ${displayName} (manual order)`);
              }
            }
            break;
            
          case 'Customer Email':
            console.log(`🔍 Customer Email debug:`, {
              hasCustomer: !!order.customer,
              customerEmail: order.customer?.email,
              emailType: typeof order.customer?.email
            });
            
            if (order.customer?.email) {
              // For debugging, let's see what email we're getting
              console.log(`📧 Processing email: "${order.customer.email}"`);
              
                             // Only skip truly placeholder emails
               if (order.customer.email === 'no-email@manual-order.com') {
                 console.log(`⚠️ Skipping placeholder email: ${order.customer.email}`);
                 // Skip this field for placeholder emails (email field type requires valid email)
               } else {
                 // Real email
                 properties[propName] = {
                   email: order.customer.email,
                 };
                 console.log(`📝 Setting "${propName}" to: ${order.customer.email}`);
               }
            } else {
              console.log(`⚠️ No customer email found or email is undefined`);
            }
            break;
            
          case 'Order Date':
            if (order.created_at) {
              properties[propName] = {
                date: {
                  start: order.created_at,
                },
              };
              console.log(`📝 Setting "${propName}" to: ${order.created_at}`);
            }
            break;
            
          case 'Shipping Address':
            if (order.shipping_address) {
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
              
              if (addressText) {
                properties[propName] = {
                  rich_text: [
                    {
                      text: {
                        content: addressText,
                      },
                    },
                  ],
                };
                console.log(`📝 Setting "${propName}" to: ${addressText}`);
              }
            }
            break;
            
          case 'Notes':
            if (order.note) {
              properties[propName] = {
                rich_text: [
                  {
                    text: {
                      content: order.note,
                    },
                  },
                ],
              };
              console.log(`📝 Setting "${propName}" to: ${order.note}`);
            }
            break;
            
          case 'Items Purchased':
            if (lineItemsText) {
              properties[propName] = {
                rich_text: [
                  {
                    text: {
                      content: lineItemsText,
                    },
                  },
                ],
              };
              console.log(`📝 Setting "${propName}" to: ${lineItemsText}`);
            }
            break;
            
          case 'Total Price':
            if (order.total_price) {
              const totalPrice = parseFloat(order.total_price);
              if (!isNaN(totalPrice)) {
                properties[propName] = {
                  number: totalPrice,
                };
                console.log(`📝 Setting "${propName}" to: ${totalPrice}`);
              }
            }
            break;
            
          case 'Order Status':
            // This is a status field, need to set the proper status
            const status = order.fulfillment_status || 'unfulfilled';
            // Map common statuses to what might be in your database
            const statusMap: { [key: string]: string } = {
              'unfulfilled': 'Unfulfilled',
              'fulfilled': 'Fulfilled', 
              'partial': 'Partially Fulfilled',
              'pending': 'Pending'
            };
            
            const mappedStatus = statusMap[status.toLowerCase()] || 'Unfulfilled';
            properties[propName] = {
              status: {
                name: mappedStatus,
              },
            };
            console.log(`📝 Setting "${propName}" to: ${mappedStatus}`);
            break;
            
          case 'Shopify Admin Link':
            if (order.order_status_url) {
              properties[propName] = {
                url: order.order_status_url,
              };
              console.log(`📝 Setting "${propName}" to: ${order.order_status_url}`);
            }
            break;
            
          case 'High Value':
            // Set high value checkbox based on price
            if (order.total_price) {
              const totalPrice = parseFloat(order.total_price);
              const isHighValue = totalPrice >= 500; // Adjust threshold as needed
              properties[propName] = {
                checkbox: isHighValue,
              };
              console.log(`📝 Setting "${propName}" to: ${isHighValue}`);
            }
            break;
            
          case 'Days Since Order':
            // Calculate days since order
            if (order.created_at) {
              const orderDate = new Date(order.created_at);
              const now = new Date();
              const daysDiff = Math.floor((now.getTime() - orderDate.getTime()) / (1000 * 60 * 60 * 24));
              properties[propName] = {
                number: daysDiff,
              };
              console.log(`📝 Setting "${propName}" to: ${daysDiff}`);
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

  /**
   * Get the database schema for debugging
   * @returns Promise<any> - The database schema
   */
  async getDatabaseSchema(): Promise<any> {
    try {
      const database = await this.notion.databases.retrieve({
        database_id: this.databaseId,
      });

      // Return a simplified version of the schema
      const schema = {
        databaseId: this.databaseId,
        properties: {}
      };

      // Extract property information
      Object.entries(database.properties as any).forEach(([propName, propConfig]: [string, any]) => {
        (schema.properties as any)[propName] = {
          type: propConfig.type,
          name: propName
        };
      });

      return schema;
    } catch (error) {
      console.error('❌ Failed to get database schema:', error);
      throw error;
    }
  }
} 