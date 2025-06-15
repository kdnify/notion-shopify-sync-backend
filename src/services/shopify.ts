import crypto from 'crypto';

export interface ShopifyStore {
  shop: string;
  accessToken: string;
}

export interface WebhookCreationResponse {
  webhook: {
    id: number;
    topic: string;
    address: string;
    created_at: string;
  };
}

export class ShopifyService {
  private apiKey: string;
  private apiSecret: string;
  private scopes: string;
  private appUrl: string;

  constructor() {
    this.apiKey = process.env.SHOPIFY_API_KEY || '';
    this.apiSecret = process.env.SHOPIFY_API_SECRET || '';
    this.scopes = process.env.SHOPIFY_SCOPES || 'read_orders,write_orders';
    this.appUrl = process.env.SHOPIFY_APP_URL || '';

    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Missing required Shopify API credentials (SHOPIFY_API_KEY, SHOPIFY_API_SECRET)');
    }
    
    if (!this.appUrl) {
      console.warn('⚠️ SHOPIFY_APP_URL not set - webhook creation will fail');
    }
  }

  /**
   * Generates the OAuth authorization URL for a shop
   */
  generateAuthUrl(shop: string, state?: string): string {
    const authUrl = new URL(`https://${shop}.myshopify.com/admin/oauth/authorize`);
    
    authUrl.searchParams.append('client_id', this.apiKey);
    authUrl.searchParams.append('scope', this.scopes);
    authUrl.searchParams.append('redirect_uri', `${this.appUrl}/auth/callback`);
    
    if (state) {
      authUrl.searchParams.append('state', state);
    }

    return authUrl.toString();
  }

  /**
   * Exchanges authorization code for access token
   */
  async getAccessToken(shop: string, code: string): Promise<string> {
    try {
      const response = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.apiKey,
          client_secret: this.apiSecret,
          code: code,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to get access token: ${response.statusText}`);
      }

      const data = await response.json() as { access_token: string };
      return data.access_token;
    } catch (error) {
      console.error('Error getting access token:', error);
      throw error;
    }
  }

  /**
   * Creates the order webhook for a shop
   */
  async createOrderWebhook(shop: string, accessToken: string): Promise<WebhookCreationResponse> {
    try {
      // Use n8n webhook endpoint instead of backend webhook
      const webhookUrl = process.env.N8N_WEBHOOK_URL || 'https://khaydien.app.n8n.cloud/webhook-test/shopify-order-webhook';

      const webhookData = {
        webhook: {
          topic: 'orders/paid',
          address: webhookUrl,
          format: 'json',
        },
      };

      const response = await fetch(`https://${shop}.myshopify.com/admin/api/2023-10/webhooks.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify(webhookData),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create webhook: ${response.statusText} - ${errorText}`);
      }

      const result = await response.json() as WebhookCreationResponse;
      console.log(`✅ Created webhook for ${shop} → n8n:`, result.webhook.id);
      console.log(`🎯 Webhook URL: ${webhookUrl}`);
      
      return result;
    } catch (error) {
      console.error('Error creating webhook:', error);
      throw error;
    }
  }

  /**
   * Lists existing webhooks for a shop
   */
  async listWebhooks(shop: string, accessToken: string): Promise<any[]> {
    try {
      const response = await fetch(`https://${shop}.myshopify.com/admin/api/2023-10/webhooks.json`, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': accessToken,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to list webhooks: ${response.statusText}`);
      }

      const data = await response.json() as { webhooks: any[] };
      return data.webhooks || [];
    } catch (error) {
      console.error('Error listing webhooks:', error);
      throw error;
    }
  }

  /**
   * Verifies the OAuth callback request
   */
  verifyOAuthCallback(query: any): boolean {
    try {
      const { hmac, ...queryWithoutHmac } = query;
      
      if (!hmac) {
        console.log('❌ No HMAC provided');
        return false;
      }

      // Sort query parameters and create query string
      const sortedParams = Object.keys(queryWithoutHmac)
        .sort()
        .map(key => `${key}=${queryWithoutHmac[key]}`)
        .join('&');

      // Generate HMAC
      const computedHmac = crypto
        .createHmac('sha256', this.apiSecret)
        .update(sortedParams)
        .digest('hex');

      // Ensure both HMACs are the same length
      if (hmac.length !== computedHmac.length) {
        console.log('❌ HMAC length mismatch:', hmac.length, 'vs', computedHmac.length);
        return false;
      }

      // Validate hex format
      if (!/^[0-9a-fA-F]+$/.test(hmac) || !/^[0-9a-fA-F]+$/.test(computedHmac)) {
        console.log('❌ Invalid hex format');
        return false;
      }

      const isValid = crypto.timingSafeEqual(
        Buffer.from(hmac, 'hex'),
        Buffer.from(computedHmac, 'hex')
      );

      return isValid;

    } catch (error) {
      console.error('❌ Error in HMAC verification:', error);
      return false;
    }
  }

  /**
   * Gets shop information
   */
  async getShopInfo(shop: string, accessToken: string): Promise<any> {
    try {
      const response = await fetch(`https://${shop}.myshopify.com/admin/api/2023-10/shop.json`, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': accessToken,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to get shop info: ${response.statusText}`);
      }

      const data = await response.json() as { shop: any };
      return data.shop;
    } catch (error) {
      console.error('Error getting shop info:', error);
      throw error;
    }
  }
} 